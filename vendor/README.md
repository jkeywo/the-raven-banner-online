# vendor/

Third-party code, committed rather than fetched.

## peerjs.min.js

PeerJS 1.5.4, from `https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js`.

```
sha256  ad5d8870d1e389914f9cba8d35be313c4327c69ee0a221e482e9bf7621136fe5
```

Vendored, not loaded from a CDN, for two reasons. The page is then entirely
same-origin, so nothing about it depends on a third party being up during the
three hours a game runs. And the version is pinned by the file itself: a
library that changed its reconnection behaviour under us between one game and
the next would be a miserable thing to debug from a venue.

To update: download the new version, put the checksum above, and run the
transport tests. They use an in-process double rather than PeerJS itself
(`tests/fakes/peerjs-shim.js`), so they will not catch a behaviour change here
— re-read `gui/net/connection-manager.js` against the changelog by hand, and
run a real two-browser session before trusting it.
