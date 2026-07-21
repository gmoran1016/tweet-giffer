# Unraid Docker Icon Design

## Goal

Show a recognizable Tweet Giffer icon in Unraid after the next updated container image is pulled.

## Asset

- Add `public/docker-icon.png`, a 1024 by 1024 square PNG.
- The visual is a simple, text-free Tweet Giffer mark: a tweet bubble paired with a small animation/film motif on a dark, Twitter-blue tile. It must remain recognizable at Unraid's small grid size.

## Image metadata

- Add Docker's `net.unraid.docker.icon` image label.
- Set its value to the stable raw GitHub URL on the `master` branch:
  `https://raw.githubusercontent.com/gmoran1016/tweet-giffer/master/public/docker-icon.png`.
- Because the label is baked into the updated image, Unraid receives the icon reference when it pulls that image. The asset URL remains available independently from the container filesystem.

## Verification

- Confirm the PNG is square and readable.
- Confirm the Dockerfile label exactly matches the committed GitHub asset path.
- Run the repository's syntax check and tests after the Dockerfile/asset change.
