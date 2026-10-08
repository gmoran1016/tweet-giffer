# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who want to share a public X/Twitter video outside X. They paste a post URL, create a card, then download or share the resulting media.

## Product Purpose

Tweet Giffer makes public X video posts portable while keeping the source post's context with the media. Success means the video can travel to other places with the author's identity and post text still attached.

## Positioning

Tweet Giffer renders a public X post's author identity and text alongside its video, then provides downloadable formats and share links with preview metadata for services such as Discord.

## Operating Context

The user works in a web page: paste a public X or Twitter status URL, wait for conversion, preview GIF, MP4, or WebM, then download a format or copy a share link. The service is self-hostable and supports Docker deployment. Conversion uses CPU, memory, and temporary storage. Public share URLs require `PUBLIC_BASE_URL` or `PUBLIC_HOSTS`; without either, share origins are restricted to loopback.

## Capabilities and Constraints

- Accepts public X/Twitter status URLs.
- Produces GIF, MP4, and WebM files. Audio is preserved in video formats when present in the source.
- Share pages provide Open Graph metadata for social previews, including Discord.
- Generated output files are removed after 24 hours.
- Conversion concurrency is capped; excess requests receive HTTP 503 rather than entering a queue.
- Public deployments must use an explicitly configured share origin or host allowlist. The request Host header is not trusted to create public share URLs.

## Evidence on Hand

- `README.md` documents the product workflow, supported formats, deployment model, and technical constraints.
- `public/favicon.svg` and `public/social-card.svg` are the current brand assets.
- No customer testimonials, usage benchmarks, or user research are present in the project. Do not invent them.

## Product Principles

- Keep the source post's identity and text attached to its media.
- Make the resulting card usable outside X through downloadable files and share links.
- Preserve source audio in video outputs when it exists.
- Handle only public posts and explain the temporary nature of generated files accurately.
