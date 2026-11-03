"""Generate placeholder review videos and custom thumbnails.

Each thumbnail is a designed image built from the file name, not a video frame.
Videos are silent H.264 MP4 with the moov atom first so they stream and seek.
"""
import subprocess
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent / "media"
THUMBS = ROOT / "thumbs"
THUMBS.mkdir(parents=True, exist_ok=True)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

# (file stem, seconds, 4 gradient colours)
VIDEOS = [
    ("Video_001", 12, ["1d3557", "457b9d", "a8dadc", "264653"]),
    ("Video_002", 25, ["3d2c8d", "916bbf", "c996cc", "22223b"]),
    ("Video_003", 40, ["2a6f4d", "5fa777", "bde0a1", "1b3a2d"]),
    ("Video_004", 30, ["6a040f", "d00000", "faa307", "370617"]),
]

def font(size):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

for stem, seconds, cols in VIDEOS:
    src = (f"gradients=s=1280x720:d={seconds}:r=30:speed=0.04:x0=0:y0=0:x1=1280:y1=720"
           f":c0=0x{cols[0]}:c1=0x{cols[1]}:c2=0x{cols[2]}:c3=0x{cols[3]}:nb_colors=4")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i", src, "-an",
                    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
                    "-crf", "27", "-preset", "medium", "-movflags", "+faststart",
                    str(ROOT / f"{stem}.mp4")], check=True)

    img = Image.new("RGB", (640, 360), f"#{cols[3]}")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 640, 360], outline=f"#{cols[2]}", width=6)
    d.ellipse([430, -80, 760, 250], fill=f"#{cols[1]}")
    d.text((36, 120), stem.replace("_", " "), font=font(64), fill="white")
    d.text((38, 210), f"{stem}.mp4  -  {seconds}s", font=font(26), fill=f"#{cols[2]}")
    img.save(THUMBS / f"{stem}.jpg", quality=88)

for p in sorted(ROOT.glob("*.mp4")):
    print(f"{p.name:16s}{p.stat().st_size / 1024:8.0f} KB")
