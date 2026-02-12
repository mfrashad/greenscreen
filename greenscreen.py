"""Green screen replacement tool - detects green screens and composites screenshots onto them."""

import argparse
import json
import os
import sys

import cv2
import numpy as np


def detect_green_mask(image, hue_range=(35, 85), sat_min=50, val_min=50):
    """Convert to HSV, threshold for green, clean with morphological ops. Returns binary mask."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    lower = np.array([hue_range[0], sat_min, val_min])
    upper = np.array([hue_range[1], 255, 255])
    mask = cv2.inRange(hsv, lower, upper)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=3)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=2)
    return mask


def find_corners(mask):
    """Find contours, get largest, approximate to 4 points. Returns 4 corners."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise ValueError("No green screen region detected")

    largest = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(largest)
    if area < 1000:
        raise ValueError(f"Green region too small (area={area})")

    peri = cv2.arcLength(largest, True)

    # Try increasing epsilon until we get 4 points
    for mult in [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10]:
        approx = cv2.approxPolyDP(largest, mult * peri, True)
        if len(approx) == 4:
            return approx.reshape(4, 2).astype(np.float32)

    # Fallback to minAreaRect
    rect = cv2.minAreaRect(largest)
    box = cv2.boxPoints(rect)
    return box.astype(np.float32)


def order_corners(pts):
    """Sort 4 points into TL, TR, BR, BL using sum/difference heuristic."""
    pts = pts.astype(np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).flatten()

    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(d)]
    bl = pts[np.argmax(d)]

    return np.array([tl, tr, br, bl], dtype=np.float32)


def apply_perspective(screenshot, corners, base_shape):
    """Warp screenshot into the quadrilateral defined by corners."""
    h, w = screenshot.shape[:2]
    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    dst = order_corners(corners)
    M = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(screenshot, M, (base_shape[1], base_shape[0]),
                                  flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    return warped


def adjust_lighting(warped, base, mask, brightness=0, contrast=0, temperature=0,
                    saturation=0, blur=0):
    """Adjust lighting of warped screenshot to match base image surroundings."""
    if brightness == 0 and contrast == 0 and temperature == 0 and saturation == 0 and blur == 0:
        # Auto-match brightness from surrounding area
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
        dilated = cv2.dilate(mask, kernel, iterations=3)
        ring = cv2.subtract(dilated, mask)

        if np.count_nonzero(ring) > 100:
            base_lab = cv2.cvtColor(base, cv2.COLOR_BGR2LAB)
            ring_l = base_lab[:, :, 0][ring > 0]
            target_l = float(np.mean(ring_l))

            warped_lab = cv2.cvtColor(warped, cv2.COLOR_BGR2LAB)
            warped_region_l = warped_lab[:, :, 0][mask > 0]
            if len(warped_region_l) > 0:
                current_l = float(np.mean(warped_region_l))
                shift = target_l - current_l
                l_channel = warped_lab[:, :, 0].astype(np.float32)
                l_channel = np.clip(l_channel + shift * 0.5, 0, 255)
                warped_lab[:, :, 0] = l_channel.astype(np.uint8)
                warped = cv2.cvtColor(warped_lab, cv2.COLOR_LAB2BGR)
        return warped

    warped_lab = cv2.cvtColor(warped, cv2.COLOR_BGR2LAB)
    l_channel = warped_lab[:, :, 0].astype(np.float32)
    b_channel = warped_lab[:, :, 2].astype(np.float32)

    # Manual brightness: shift L channel
    if brightness != 0:
        l_channel = l_channel + brightness
    # Manual contrast: scale L channel around its mean
    if contrast != 0:
        mean_l = np.mean(l_channel)
        factor = (100 + contrast) / 100.0
        l_channel = mean_l + factor * (l_channel - mean_l)
    # Manual temperature: shift B channel (positive=warm, negative=cool)
    if temperature != 0:
        b_channel = b_channel + temperature

    warped_lab[:, :, 0] = np.clip(l_channel, 0, 255).astype(np.uint8)
    warped_lab[:, :, 2] = np.clip(b_channel, 0, 255).astype(np.uint8)
    warped = cv2.cvtColor(warped_lab, cv2.COLOR_LAB2BGR)

    # Saturation: convert to HSV, scale S channel
    if saturation != 0:
        hsv = cv2.cvtColor(warped, cv2.COLOR_BGR2HSV).astype(np.float32)
        factor = (100 + saturation) / 100.0
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] * factor, 0, 255)
        warped = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

    # Blur: Gaussian blur with odd kernel size
    if blur > 0:
        ksize = int(blur) * 2 + 1
        warped = cv2.GaussianBlur(warped, (ksize, ksize), 0)

    return warped


def composite(base, warped, mask):
    """Alpha-composite warped image onto base with feathered edges."""
    blurred_mask = cv2.GaussianBlur(mask, (5, 5), 0)
    alpha = blurred_mask.astype(np.float32) / 255.0

    if len(alpha.shape) == 2:
        alpha = alpha[:, :, np.newaxis]

    result = (warped.astype(np.float32) * alpha +
              base.astype(np.float32) * (1 - alpha))
    return result.astype(np.uint8)


def process(base_path, screenshot_path, output_path, corners=None,
            brightness=0, contrast=0, temperature=0,
            hue_range=(35, 85), sat_min=50, val_min=50):
    """Full pipeline: detect green screen, warp screenshot, adjust lighting, composite."""
    base = cv2.imread(base_path)
    if base is None:
        raise FileNotFoundError(f"Cannot read base image: {base_path}")

    screenshot = cv2.imread(screenshot_path)
    if screenshot is None:
        raise FileNotFoundError(f"Cannot read screenshot: {screenshot_path}")

    mask = detect_green_mask(base, hue_range, sat_min, val_min)

    if corners is None:
        corners = find_corners(mask)

    ordered = order_corners(corners)
    warped = apply_perspective(screenshot, ordered, base.shape)
    warped = adjust_lighting(warped, base, mask, brightness, contrast, temperature)

    # Create mask from ordered corners for compositing
    comp_mask = np.zeros(base.shape[:2], dtype=np.uint8)
    cv2.fillConvexPoly(comp_mask, ordered.astype(np.int32), 255)

    result = composite(base, warped, comp_mask)

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    cv2.imwrite(output_path, result)
    print(f"Saved: {output_path}")
    return result


def process_bulk(base_path, screenshot_paths, output_dir, corners=None,
                 brightness=0, contrast=0, temperature=0,
                 hue_range=(35, 85), sat_min=50, val_min=50):
    """Detect once from base, apply to all screenshots."""
    base = cv2.imread(base_path)
    if base is None:
        raise FileNotFoundError(f"Cannot read base image: {base_path}")

    mask = detect_green_mask(base, hue_range, sat_min, val_min)

    if corners is None:
        corners = find_corners(mask)

    ordered = order_corners(corners)
    os.makedirs(output_dir, exist_ok=True)

    comp_mask = np.zeros(base.shape[:2], dtype=np.uint8)
    cv2.fillConvexPoly(comp_mask, ordered.astype(np.int32), 255)

    results = []
    for ss_path in screenshot_paths:
        screenshot = cv2.imread(ss_path)
        if screenshot is None:
            print(f"Warning: skipping unreadable file {ss_path}", file=sys.stderr)
            continue

        warped = apply_perspective(screenshot, ordered, base.shape)
        warped = adjust_lighting(warped, base, mask, brightness, contrast, temperature)
        result = composite(base, warped, comp_mask)

        name = os.path.splitext(os.path.basename(ss_path))[0]
        out_path = os.path.join(output_dir, f"{name}_composite.png")
        cv2.imwrite(out_path, result)
        print(f"Saved: {out_path}")
        results.append(out_path)

    return results


def process_from_arrays(base, screenshot, corners=None,
                        brightness=0, contrast=0, temperature=0,
                        saturation=0, blur=0,
                        hue_range=(35, 85), sat_min=50, val_min=50):
    """Process from numpy arrays (for server use). Returns result array."""
    mask = detect_green_mask(base, hue_range, sat_min, val_min)

    if corners is None:
        corners = find_corners(mask)

    ordered = order_corners(corners)
    warped = apply_perspective(screenshot, ordered, base.shape)
    warped = adjust_lighting(warped, base, mask, brightness, contrast, temperature,
                             saturation, blur)

    comp_mask = np.zeros(base.shape[:2], dtype=np.uint8)
    cv2.fillConvexPoly(comp_mask, ordered.astype(np.int32), 255)

    return composite(base, warped, comp_mask)


def detect_from_array(image, hue_range=(35, 85), sat_min=50, val_min=50):
    """Detect green screen corners from numpy array. Returns ordered corners."""
    mask = detect_green_mask(image, hue_range, sat_min, val_min)
    corners = find_corners(mask)
    return order_corners(corners)


def parse_corners(s):
    """Parse corners string like 'x,y x,y x,y x,y' into numpy array."""
    parts = s.strip().split()
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("Corners must be 4 space-separated x,y pairs")
    pts = []
    for p in parts:
        xy = p.split(",")
        if len(xy) != 2:
            raise argparse.ArgumentTypeError(f"Invalid point: {p}")
        pts.append([float(xy[0]), float(xy[1])])
    return np.array(pts, dtype=np.float32)


def parse_hue_range(s):
    """Parse hue range like '35,85'."""
    parts = s.split(",")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("Hue range must be two comma-separated values")
    return (int(parts[0]), int(parts[1]))


def main():
    parser = argparse.ArgumentParser(description="Green screen replacement tool")
    parser.add_argument("--base", required=True, help="Base image with green screen")
    parser.add_argument("--screenshots", nargs="+", help="Screenshot image(s) to composite")
    parser.add_argument("--output", help="Output path (single screenshot mode)")
    parser.add_argument("--output-dir", default="./output", help="Output directory (bulk mode)")
    parser.add_argument("--corners", type=parse_corners,
                        help="Manual corners as 'x,y x,y x,y x,y' (TL TR BR BL)")
    parser.add_argument("--brightness", type=float, default=0, help="Brightness adjustment (-100 to 100)")
    parser.add_argument("--contrast", type=float, default=0, help="Contrast adjustment (-100 to 100)")
    parser.add_argument("--temperature", type=float, default=0, help="Temperature adjustment (-50 to 50)")
    parser.add_argument("--detect-only", action="store_true", help="Only detect and print corners as JSON")
    parser.add_argument("--hue-range", type=parse_hue_range, default="35,85",
                        help="Green hue range as 'low,high' (default: 35,85)")

    args = parser.parse_args()

    if args.detect_only:
        base = cv2.imread(args.base)
        if base is None:
            print(f"Error: cannot read {args.base}", file=sys.stderr)
            sys.exit(1)
        corners = detect_from_array(base, hue_range=args.hue_range)
        print(json.dumps({
            "corners": corners.tolist(),
            "width": base.shape[1],
            "height": base.shape[0],
        }))
        return

    if not args.screenshots:
        parser.error("--screenshots is required (unless using --detect-only)")

    if len(args.screenshots) == 1 and args.output:
        process(args.base, args.screenshots[0], args.output,
                corners=args.corners, brightness=args.brightness,
                contrast=args.contrast, temperature=args.temperature,
                hue_range=args.hue_range)
    else:
        process_bulk(args.base, args.screenshots, args.output_dir,
                     corners=args.corners, brightness=args.brightness,
                     contrast=args.contrast, temperature=args.temperature,
                     hue_range=args.hue_range)


if __name__ == "__main__":
    main()
