# Publish application code with a private operational boundary

Publish Flipper under MIT in a fresh public repository at the original
`sergkhl/flipper` URL, retaining the predecessor repository and its history
privately under a separate name. Publish only source, synthetic tests, portable
instructions and resolved design decisions. Runtime seller data,
credentials, private host configuration, personal author email and operational
receipts remain outside the published tree. Use a public no-reply commit identity.
TechAPI-derived datasets retain CC BY-SA 4.0 attribution separately from code.

A same-repository history reset was considered first, but a live check confirmed
that historical commits still resolved by hash after rewriting the branch. A
fresh repository isolates the public project's Git objects while preserving its
original URL. Verify anonymous code access and the absence of predecessor commit
objects in the public repository; keep the predecessor private. This supersedes
the earlier choice to change visibility on the original repository object.
