---
'radius-sdk': minor
'radius-cli': minor
---

Base and Base Sepolia default to the Radius facilitators (`facilitator.radiustech.xyz`, `facilitator.testnet.radiustech.xyz`), as the Radius platform catalog names them; Base Sepolia no longer defaults to x402.org and Base mainnet no longer needs a named facilitator. Presets carry their mainnet/testnet `counterpart` (`counterpartOf()`), and `PRESET_NAMES` / `NETWORK_ALIASES` list the preset ids and aliases, so `NetworkName` follows the preset list. The CLI derives `wallet pay`'s networks from the presets: `RADIUS_<PRESET>_RPC_URL` and `rpcUrls["<preset>"]` set the RPC of every non-Radius preset (`RADIUS_BASE_RPC_URL` and `RADIUS_BASE_SEPOLIA_RPC_URL` are unchanged).
