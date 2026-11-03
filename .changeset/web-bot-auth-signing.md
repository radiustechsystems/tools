---
"radius-cli": minor
---

Sign `wallet pay` requests as a Web Bot Auth agent (RFC 9421 HTTP message signatures, Ed25519) when `RADIUS_SIGNING_KEY` names an Ed25519 private key file (PKCS#8 PEM, or a JWK with `d`). Each request carries `Signature-Agent`, `Signature-Input` and `Signature` headers covering `@authority` and `signature-agent`, valid for 60 seconds; `RADIUS_SIGNATURE_AGENT` sets the origin that hosts the key directory (default `https://radiustech.xyz`). Signing is off by default, and redirects are followed by the CLI so that each hop is signed for its own origin. The new `radius-cli bot-auth directory` command prints the key directory (JWKS) for the key's public half.
