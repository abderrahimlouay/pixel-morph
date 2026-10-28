# pixel-morph

Rearrange the pixels of one image into another, animated in the browser.

A FastAPI backend matches the pixels of a source image to positions in a target
image (color + spatial cost, solved with parallel swap refinement). The frontend
animates every pixel from its original spot to its new one on a canvas.

## Run

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Then open http://127.0.0.1:8000

## Stack

- Python, FastAPI, NumPy, OpenCV
- Vanilla JS + canvas frontend (`static/`)
