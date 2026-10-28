#!/usr/bin/env bash
# push.sh: create the needed files, commit, and push Pixel Morph to GitHub.
# Usage: ./push.sh ["commit message"]
set -euo pipefail

REPO_URL="https://github.com/abderrahimlouay/pixel-morph.git"
BRANCH="main"
MSG="${1:-Initial commit: Pixel Morph}"

SLUG="abderrahimlouay/pixel-morph"
DESC="Rearrange the pixels of one image into another, animated in the browser (FastAPI + canvas)"
TOPICS=(python fastapi opencv numpy image-processing computer-vision pixel-art animation canvas javascript)

HAVE_GH=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  HAVE_GH=1
fi

# --- .gitignore (only if missing) ---
if [ ! -f .gitignore ]; then
  cat > .gitignore <<'EOF'
venv/
.venv/
__pycache__/
*.pyc
.env
.DS_Store
EOF
  echo "created .gitignore"
fi

# --- README.md (only if missing) ---
if [ ! -f README.md ]; then
  cat > README.md <<'EOF'
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
EOF
  echo "created README.md"
fi

# --- sanity check ---
if [ ! -d static ]; then
  echo "warning: static/ folder not found, main.py mounts it" >&2
fi

# --- git init + branch ---
if [ ! -d .git ]; then
  git init
fi
git branch -M "$BRANCH"

# --- make sure venv / pycache are not tracked ---
git rm -r --cached --ignore-unmatch -q venv .venv __pycache__ 2>/dev/null || true

# --- commit ---
git add .
if git diff --cached --quiet; then
  echo "nothing new to commit"
else
  git commit -m "$MSG"
fi

# --- remote ---
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

# --- create the GitHub repo if it doesn't exist yet (needs gh) ---
if [ "$HAVE_GH" -eq 1 ] && ! gh repo view "$SLUG" >/dev/null 2>&1; then
  gh repo create "$SLUG" --public --description "$DESC"
fi

# --- push ---
git push -u origin "$BRANCH"

# --- description + topics ---
if [ "$HAVE_GH" -eq 1 ]; then
  args=()
  for t in "${TOPICS[@]}"; do args+=(--add-topic "$t"); done
  gh repo edit "$SLUG" --description "$DESC" "${args[@]}"
  echo "description and topics set"
else
  echo
  echo "gh CLI not found or not logged in, set these manually on GitHub:"
  echo "  repo page -> gear icon next to 'About'"
  echo "  Description: $DESC"
  echo "  Topics: ${TOPICS[*]}"
fi

echo "done: $REPO_URL"
