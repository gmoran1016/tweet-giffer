# Unraid Docker Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable Unraid Docker icon that is automatically discovered from an updated Tweet Giffer image.

**Architecture:** Store a square application icon with the static frontend assets, then expose its permanent GitHub raw URL through Docker's `net.unraid.docker.icon` label. A deployment-config test locks that URL to the tracked asset path so an image update cannot silently lose its icon.

**Tech Stack:** PNG asset, Dockerfile image labels, Node.js built-in test runner.

## Global Constraints

- Asset path is exactly `public/docker-icon.png` and must be a 1024 by 1024 PNG.
- The icon contains no text and remains identifiable at Unraid's small grid size.
- Docker label is exactly `net.unraid.docker.icon`.
- Label URL is exactly `https://raw.githubusercontent.com/gmoran1016/tweet-giffer/master/public/docker-icon.png`.
- Validate with `npm test` and `npm run check`.

---

### Task 1: Lock the Unraid metadata contract with a deployment test

**Files:**

- Modify: `test/deployment-config.test.js`
- Modify: `Dockerfile`

**Interfaces:**

- Consumes: the Dockerfile text read at `path.join(root, 'Dockerfile')`.
- Produces: a test that requires the exact `net.unraid.docker.icon` URL in an image label.

- [ ] **Step 1: Write the failing test**

Append this test to `test/deployment-config.test.js`:

```js
test('Docker image advertises the stable Unraid icon URL', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(
    dockerfile,
    /LABEL net\.unraid\.docker\.icon="https:\/\/raw\.githubusercontent\.com\/gmoran1016\/tweet-giffer\/master\/public\/docker-icon\.png"/
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/deployment-config.test.js`

Expected: FAIL because the Dockerfile does not yet contain `net.unraid.docker.icon`.

- [ ] **Step 3: Add the Docker image label**

Insert this line after the `WORKDIR /app` line in `Dockerfile`:

```dockerfile
LABEL net.unraid.docker.icon="https://raw.githubusercontent.com/gmoran1016/tweet-giffer/master/public/docker-icon.png"
```

- [ ] **Step 4: Run the deployment test to verify it passes**

Run: `node --test test/deployment-config.test.js`

Expected: all three deployment configuration tests PASS.

- [ ] **Step 5: Commit the metadata contract**

```powershell
git add -- Dockerfile test/deployment-config.test.js
git commit -m "feat: advertise Unraid Docker icon"
```

### Task 2: Create and verify the Docker icon asset

**Files:**

- Create: `public/docker-icon.png`

**Interfaces:**

- Consumes: the asset URL encoded in `Dockerfile`.
- Produces: a public static PNG available at `/docker-icon.png` when the service is running and at the committed raw GitHub URL after push.

- [ ] **Step 1: Generate the icon source**

Generate a square 1024 by 1024 application icon using this prompt:

```text
Use case: logo-brand
Asset type: Unraid Docker application icon for Tweet Giffer
Primary request: a clean, bold, text-free application icon that conveys turning a social-media post into an animated GIF or video
Subject: one white rounded tweet bubble paired with a compact magenta filmstrip/GIF motif and a small play triangle
Style/medium: crisp modern vector-like flat illustration with soft depth, professional Docker/app icon polish
Composition/framing: centered symbol with generous safe margins, square 1:1 composition, no tiny details
Lighting/mood: confident, energetic, clean
Color palette: deep navy background, Twitter-blue and cyan accent glow, white tweet bubble, magenta animation accent
Constraints: no letters, no words, no Twitter bird logo, no watermark, no border, unmistakable at 64 by 64 pixels
Avoid: screenshots, a full tweet card, photographic imagery, gradients that reduce contrast
```

- [ ] **Step 2: Save the selected asset**

Copy the selected generated PNG to `public/docker-icon.png` without overwriting any other project asset.

- [ ] **Step 3: Validate its file format and dimensions**

Run:

```powershell
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile((Resolve-Path 'public/docker-icon.png'))
"$($image.RawFormat.Guid) $($image.Width)x$($image.Height)"
$image.Dispose()
```

Expected: PNG format GUID `b96b3caf-0728-11d3-9d7b-0000f81ef32e` and `1024x1024` dimensions.

- [ ] **Step 4: Inspect visual readability**

Open `public/docker-icon.png` at normal size and confirm a tweet bubble and animation motif are centered, high contrast, and readable without text.

- [ ] **Step 5: Commit the asset**

```powershell
git add -- public/docker-icon.png
git commit -m "feat: add Unraid Docker icon asset"
```

### Task 3: Run the project verification gates

**Files:**

- Verify: `Dockerfile`
- Verify: `public/docker-icon.png`
- Verify: `test/deployment-config.test.js`

**Interfaces:**

- Consumes: the icon asset and the Dockerfile label from Tasks 1 and 2.
- Produces: evidence that the repository test suite and syntax checks remain green.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all Node tests PASS.

- [ ] **Step 2: Run syntax checks**

Run: `npm run check`

Expected: exits with code 0.

- [ ] **Step 3: Review the final diff**

Run: `git diff HEAD~2..HEAD --check`

Expected: no whitespace errors; the final history contains one metadata/test commit and one image-asset commit.
