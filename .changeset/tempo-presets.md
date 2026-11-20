---
'radius-sdk': minor
'radius-cli': minor
---

Tempo presets. `tempo` (eip155:4217) and `tempo-moderato` (eip155:42431) pay in OUSD, a TIP-20 stablecoin with EIP-2612 permit and no EIP-3009, so payments are Permit2 with gas sponsoring, settled by the Radius facilitators. `PaymentNetwork.nativeBalance` says whether `eth_getBalance` means anything on a chain (false on Tempo, which has no native coin), and `wallet balance` now shows the configured network's payment asset and, where there is one, its native coin, instead of SBC and RUSD on every network.
