# Minecraft Bedrock textures

Textures © Mojang AB. All rights reserved.

Source: [https://github.com/Mojang/bedrock-samples](https://github.com/Mojang/bedrock-samples/tree/15701fa9c13923f12662984c32c124327e40e3d3), vanilla Bedrock 1.26.60.5.

Pinned commit: `15701fa9c13923f12662984c32c124327e40e3d3`.

Archive SHA-256: `79d3f0f25569cdcda48014d8393f9cc2ae9527c0a6ece459821cfcd9eb442dc9`.

The PNG files in `textures/items/` and `textures/blocks/` are copied byte-for-byte from that official resource pack. Item atlas images are preferred; where the pack has no separate inventory sprite, the dashboard uses an official carried/block face texture. The manifest includes a SHA-256 hash, size, and dimensions for every installed PNG. No artwork is generated or redrawn. Unknown textures remain unavailable.

These assets are subject to the [Minecraft EULA](https://www.minecraft.net/en-us/eula) and [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines). They are not covered by this Bot’s code license. The original source license is preserved in [LICENSE.md](LICENSE.md).

This is an unofficial Minecraft Bot dashboard. It is not approved by or associated with Mojang or Microsoft.

Regenerate with `python scripts/update-minecraft-textures.py`; the helper verifies the pinned source archive hash.
