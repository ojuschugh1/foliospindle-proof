# FolioSpindle Proof

FolioSpindle Proof is a thin Obsidian community plugin (id `foliospindle-proof`) that I wrote as evidence of prior work on Sia for a Sia Foundation Small Grant proposal. It is unfunded pre-application evidence. It is not the product and it is not a sync plugin. Its purpose is to retire four integration risks for the proposed FolioSpindle sync plugin before I ask for funding: packaging the Sia Storage SDK WASM inside one `main.js` in the normal community plugin release shape, authorizing and reconnecting against a Sia indexer from inside Obsidian, transferring bytes over WebTransport from Obsidian on macOS and from one physical iPhone, and enrolling a second installation without copying a secret.

Everything the plugin does happens inside a command I invoke from the command palette, and every command writes a JSON record into the vault so the evidence can be read off the device without a debugger. The records feed the measurement files under `measurements/` and the gate report below. The proof costs nothing to run: GitHub for the repository, CI and releases, the free tier of the hosted indexer, and my own Mac and iPhone.

## What the plugin does

The plugin adds seven commands: `Check runtime capability`, `Connect to indexer`, `Remove stored credential`, `Upload fixtures and probe`, `Download fixtures from receipt`, `Enter demo receipt` and `Observe object events`. It has one settings field, the indexer URL, which accepts only `https` URLs and defaults to `https://sia.storage`. There is no ribbon icon, status bar item, view or menu.

`Check runtime capability` reports `isSecureContext`, `typeof WebTransport`, the platform class, the operating system version where the runtime exposes one, the Obsidian API version, the plugin version, the SDK version, the byte size and SHA-256 hash of the installed `main.js` as read on the device, and how long the WASM took to initialize from the embedded bytes. If `isSecureContext` is not `true` or `typeof WebTransport` is not `"function"`, the plugin refuses every transfer command and names what is missing together with the minimum supported platforms: iOS 26.4 or later; a Chromium WebView with WebTransport on Android; a desktop Obsidian build with WebTransport.

`Connect to indexer` runs the SDK connection flow. It requests a connection with fixed application metadata, opens the approval URL in the system browser on desktop or shows it as selectable text on mobile, and waits up to ten minutes for approval. When the indexer reports no existing application for the account (`reconnecting()` false) the command generates an application phrase, registers the application key from it, stores the exported 32-byte seed in Obsidian's SecretStorage and shows the phrase exactly once. When the application already exists (`reconnecting()` true) the command asks me to type that phrase, checks with `matchesExistingAppKey` that it derives the already registered key and only then registers and stores the seed. After a restart the transfer commands reconnect from the stored seed with `connected(appKey)` and no new approval. `Remove stored credential` deletes the seed and drops the live connection.

`Upload fixtures and probe` sends the two Markdown fixtures through one packed upload session, the binary attachment as one separate object and a small throwaway probe object, pins all four and stores a demo receipt that lists each object's name, byte length, SHA-256 hash, object id and upload duration. The receipt holds no secret, so I move it between devices by any channel. `Enter demo receipt` accepts a pasted receipt on the other installation and validates every field. `Download fixtures from receipt` fetches the three fixtures named in the stored receipt, hashes the downloaded bytes, compares the hashes with the receipt and with `fixtures/SHA256SUMS` and writes the files into the proof folder. `Observe object events` creates, updates and deletes a probe object while paging the object event feed, and records every page.

## Network use and account

The plugin uses the network and requires a Sia Storage account. It talks to the indexer at the configured URL (default `https://sia.storage`, the hosted indexer with a free 50 GB tier) and to the Sia hosts the SDK selects, and to nothing else. It sends network requests only while one of its commands is running. It sends no telemetry and has no crash reporting or update channel. It loads no code from the network: the SDK WASM is embedded in `main.js` as data and decoded on the device.

The SDK is `@siafoundation/sia-storage` version 0.1.1, pinned exactly in `package.json`. The plugin imports only the package's `./wasm` export and initializes it from the embedded bytes; it never imports the package root entry, the stream worker or any sharing method. The transport is WebTransport, which the SDK uses exclusively. iCloud Private Relay must be off on the Mac and on the iPhone before a transfer, because the SDK's WebTransport connections do not work through it. The capability check prints that hint on both platforms and the plugin repeats it when a transfer fails with a transport error.

## Test vaults and proof folder

I run the plugin only in vaults created for this proof: `FolioSpindle Proof Mac` on my Mac and `FolioSpindle Proof iPhone` on my iPhone (a local vault, not iCloud). If I run the Android emulator, its vault is `FolioSpindle Proof Android`. Inside each vault the plugin writes only into the proof folder `foliospindle-proof`: the downloaded fixtures go into `foliospindle-proof/` and the JSON records go into `foliospindle-proof/records`, one file per command invocation named after the command and its start time. Apart from that folder the plugin writes only its own plugin configuration (`data.json`, which holds the indexer URL and the demo receipt). It never watches the vault and never touches any other file.

## Secrets

I use a dedicated Sia Storage account created for this proof. Its recovery phrase exists in no file on any device used for the proof; I wrote it down offline. The application phrase that `Connect to indexer` shows once during the macOS run is kept offline in the same way: the plugin holds it only in local variables while that command runs, never writes it anywhere, and I type it by hand on the second installation. The plugin has no code path that accepts, displays or stores the account recovery phrase.

The only credential the plugin stores is the exported application key seed, base64url-encoded, in Obsidian's SecretStorage under the id `foliospindle-proof-app-key`, so it never lands in `data.json`. Every string the plugin writes to a notice, a record or the receipt passes through a redactor that removes any hexadecimal or base64 encoding of the seed.

`manifest.json` declares `minAppVersion` `1.11.4`, the lowest Obsidian version that provides SecretStorage. I take that from the `@since 1.11.4` tag on `App.secretStorage` in the API declaration file: in the pinned `obsidian` package 1.11.4 it is `node_modules/obsidian/obsidian.d.ts` line 456, two lines above `secretStorage: SecretStorage;` on line 458. `SecretStorage` has `setSecret`, `getSecret` and `listSecrets` and no removal method, so `Remove stored credential` overwrites the secret with the empty string. After removal, `listSecrets()` may keep showing the id `foliospindle-proof-app-key` with an empty value; the plugin treats an empty value as no credential and refuses the transfer commands until a new connection completes.

The application metadata sent to the indexer is the same on every installation: `appId` is the SHA-256 hash of the plugin id, `1c319f5148a02f9274f4eddb8d2e9abe042292f2b5c8d93ea6acbe3371b08fec`; the name is `FolioSpindle Proof`; the description is `Unfunded pre-application proof for a notes vault sync plugin`; the `serviceUrl` is `https://github.com/ojuschugh1/foliospindle-proof`; there is no `callbackUrl`. To recompute the `appId`, run `printf 'foliospindle-proof' | shasum -a 256`.

## Build

I build with Node 24 (`engines.node` is `>=22.18.0`). Every dependency and devDependency is pinned to an exact version in `package.json` and listed in `dependency-allowlist.txt`: the SDK 0.1.1, `obsidian` 1.11.4, `esbuild` 0.28.2, `typescript` 5.9.3, `eslint` 9.39.5 and `eslint-plugin-obsidianmd` 0.4.2 among them. Tests use `node:test` with no test package.

```
npm ci
npm run build
npm test
npm run lint
npm run check:artifact
npm run check:reproducible
npm run check:boundary
npm run check:repo
npm run check:fixtures
npm run check:comments
npm run check:text
npm run check:commits
```

`npm run build` typechecks with `tsc -noEmit -skipLibCheck`, verifies the fixtures against `fixtures/SHA256SUMS`, then bundles `src/main.ts` with esbuild into a minified `main.js` with the SDK WASM, the fixtures and the checksum file embedded as base64. `main.js` is gitignored; the release carries it. The release artifact is exactly `main.js` plus `manifest.json`, and the release also attaches a `SHA256SUMS` file. I note the artifact hash with `shasum -a 256 main.js`; the same hash has to appear in every measurement record.

`check:artifact` checks that `main.js` is at most 5,242,880 bytes, has no source map comment, embeds the exact WASM and fixture bytes, contains none of `import.meta`, `initSia`, `check-relay.sia.storage`, `navigator.serviceWorker` or `stream-worker`, bundles inputs only from `src/`, `fixtures/` and `node_modules/`, and equals a fresh production build byte for byte. `check:reproducible` clones the checkout twice, builds both and compares the hashes. `check:boundary` scans every file under `src/` for the denylisted identifiers in `scripts/boundary-denylist.txt` that would indicate funded work or excluded SDK surface. `check:repo` checks the required files, the manifest fields, the `.gitignore` entries, the exact versions, the allowlist and the tracked file categories. `check:fixtures` checks the fixture sizes, the UTF-8 requirement and `SHA256SUMS`. `check:comments` fails on any comment token in the TypeScript. `check:text` fails on any en dash, em dash or emoji in a tracked text file and checks the phrases this README and the measurement records must and must not contain. `check:commits` checks that every commit message is one line written by me.

CI (`.github/workflows/ci.yml`) runs the same commands in that order on a GitHub-hosted runner, plus `npm audit --omit=dev --audit-level=high` and a gitleaks scan over the full history, and uploads `main.js` as a workflow artifact. It uses no paid service, no repository secret and no self-hosted runner. `release.yml` builds on a tag of the form `MAJOR.MINOR.PATCH`, checks that the tag equals `manifest.version`, and creates a draft release with `main.js`, `manifest.json` and `SHA256SUMS`; publishing it is a manual click.

The file layout, script names, build configuration and lint configuration follow `obsidianmd/obsidian-sample-plugin` at commit `07ceb81d1fb3`.

## Install

Obsidian installs a community plugin from `main.js` and `manifest.json` alone. The steps below use the files from `npm run build` or from a release.

macOS:

1. Create the vault `FolioSpindle Proof Mac`.
2. Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/foliospindle-proof/`.
3. In Settings, Community plugins, turn off Restricted mode and enable FolioSpindle Proof.
4. Turn iCloud Private Relay off.

iPhone, primary path (Finder over USB):

1. On the Mac, create a folder `FolioSpindle Proof iPhone` containing `.obsidian/plugins/foliospindle-proof/main.js` and `manifest.json`.
2. Connect the iPhone by USB, open Finder, select the iPhone, open the Files tab, open Obsidian and drag the vault folder in.
3. Open Obsidian on the iPhone and open that folder as a local vault stored on the phone, not in iCloud.
4. Enable community plugins and enable FolioSpindle Proof.
5. Turn iCloud Private Relay off and confirm iOS 26.4 or later.

iPhone, alternative path (BRAT): install the BRAT plugin, add `ojuschugh1/foliospindle-proof` as a beta plugin so BRAT fetches `main.js` and `manifest.json` from a published release, then enable the plugin. The vault stays local, not iCloud.

Android emulator (secondary data point):

1. Create an Android Studio emulator with a Play image and install Obsidian from the Play Store.
2. On the Mac, create a folder `FolioSpindle Proof Android` containing `.obsidian/plugins/foliospindle-proof/main.js` and `manifest.json`.
3. Push it with `adb push "FolioSpindle Proof Android" /sdcard/Documents/`.
4. In Obsidian, open that folder as a vault, enable community plugins and enable FolioSpindle Proof.

## Fixtures

The repository commits three fixtures under `fixtures/` together with `fixtures/SHA256SUMS`. The fixtures are embedded in `main.js`, so the test vault needs no fixture file for the upload to work.

| File | Bytes | SHA-256 |
|---|---|---|
| `fixtures/fixture-a.md` | 6,203 | `2c02b2d6ea077ccc3c8aada95f30102c5a91677355399536fa314373a65394de` |
| `fixtures/fixture-b.md` | 12,222 | `7c44401d784ebb861907a83e397973f337e945bd02629b1e33994d191023b2e3` |
| `fixtures/attachment.bin` | 262,144 | `a1b8b1a0756118e2e909cc1574d5774910dcde710b7527f7224641951907be67` |

`shasum -a 256 -c SHA256SUMS` run in `fixtures/` reports OK for all three. `fixture-a.md` is ASCII Markdown; `fixture-b.md` contains Latin with diacritics, Greek, Devanagari and CJK text, so it exercises multi-byte UTF-8; `attachment.bin` is random bytes.

The hash comparison is an application-level byte check performed by the plugin. It hashes the bytes it hands to the SDK on upload and the complete bytes it receives on download with its own SHA-256 implementation and compares the download hash with the receipt hash and with the committed hash. Object IDs are not hashes of the fixture bytes; the SDK derives them from the encrypted slab layout, so a matching object id says nothing about content and the byte check is what establishes identity.

## Object events

I describe the SDK's `objectEvents` feed as a coalesced current-state feed: one entry per object id carrying `id`, `deleted`, `updatedAt` and an optional decrypted object, where an id may repeat across pages. The feed reports the current state of each object, not the sequence of changes that led to it. `Observe object events` pages the feed two events at a time through four passes (create, update, deletion and incremental) around one probe object and records five observations: how many distinct events the probe produced in each pass, whether the update moved `updatedAt` forward, whether the deletion pass carried a tombstone with `deleted` true and no object, whether any id spanned more than one page, and whether every event of the incremental pass is later than the deletion cursor. Those observations are the evidence for gate G5.

## Device matrix

One release artifact, identified by one `main.js` SHA-256 hash, runs on every platform. A platform is listed as tested only when a committed measurement record for it contains a value for every required field listed in `measurements/README.md`. Until then it is `not yet tested`. If the iPhone reports an iOS version below 26.4 or a `typeof WebTransport` other than `"function"`, the capability check refuses the transfer commands, the record keeps that refusal, and I list the platform as `unsupported runtime`, not as tested.

| Platform | Device | Role | Status | Measurement record |
|---|---|---|---|---|
| macOS | Obsidian for macOS on my Mac | primary installation | not yet tested | pending |
| iOS | my physical iPhone, iOS 26.4 or later, WebTransport required | secondary installation | not yet tested | pending |
| Android emulator | Android Studio emulator with a Play image, labels `emulator` and `secondary` | further secondary installation, secondary data point | not yet tested | pending |

## Measurement records

Each proof run produces one JSON file under `measurements/`, named `<label>-<date>.json`, assembled on the Mac from the records the plugin wrote on the device with `node scripts/assemble-measurement.mjs --records <dir> --label <label> --device "<model>" --os "<version>" --date YYYY-MM-DD`, with `--tag emulator --tag secondary` added for the emulator and `--entered <receipt.json>` carrying the other installation's receipt whenever the run includes a cross-installation download or probe authority steps. `measurements/README.md` describes the file layout and the required fields. The demo receipts used in a run are embedded in the record as `receipts.produced` and `receipts.entered`.

The macOS record will be `measurements/macos-<date>.json`, the iOS record `measurements/ios-<date>.json` and the Android emulator record `measurements/android-emulator-<date>.json`. All three are pending; the links go into the device matrix above once the files are committed.

## Gate report

The five gates come from my grant strategy. Each records `pass` or `fail` with the measurement record fields that support it once the macOS and iOS records are committed; until then every gate is `pending`. The script that assembles a measurement record prints an advisory per-platform summary of the same five gates, which I copy here by hand and check against the record.

| Gate | What it checks | Requirements | Result | Supporting measurement record fields |
|---|---|---|---|---|
| G1 Single-file packaging | The normal community plugin release shape can initialize from one `main.js`; the plugin does not fetch executable code or require a separately installed WASM asset. | 1, 2 | pending | `artifact.mainJsBytes`, `artifact.mainJsSha256`, `artifact.wasmInitMs`, `artifact.wasmSha256`, `capability.decision`, `capability.onloadMs`, and the capability record taken with every network interface off |
| G2 Direct authorization and transfer | Desktop and one physical mobile platform complete authorization, upload and download through the official SDK with no proxy or relay operated by me. | 3, 5, 7 | pending | `connect.outcome`, `connect.publicKeyHex`, `upload.objects`, `download.own.outcome`, in both the macOS and the iOS record |
| G3 Byte identity and mobile stability | All three downloaded fixtures are byte-identical to their inputs, and the mobile run completes without a crash or out-of-memory failure. | 5, 7 | pending | `download.own.objects[*].match`, `downloadedSha256`, `receiptSha256`, `committedSha256`, `upload.memory`, with the iOS record complete |
| G4 Lifecycle behaviours | Restart reconnection, second-install enrollment, credential removal, secure-context detection and unsupported-runtime diagnostics behave as documented. | 2, 3, 4 | pending | `reconnectAfterRestart`, `credentialRemoval`, `connect.plan` and `connect.publicKeyHex` equal across both records, `download.cross`, `events.authority`, `capability.platform.isSecureContext`, `capability.platform.webTransportType`, `capability.minimumPlatforms` |
| G5 Live events | Live object events match the cursor, coalescing, metadata-update and tombstone assumptions used in the proposal. | 6 | pending | `events.observations` (a) to (e) and `events.description` |

The outcome follows the gates. It is `go` only when all five gates record `pass`. It is `no-go` when G1 fails or any one of the G2 sub-checks (authorization, transfer, or the mobile platform) fails, whatever the aggregate G2 result says, and then the proposal is not submitted with this proof. It is `architecture-revision-required` when G5 fails while immutable manifests plus polling remain viable; in that case I list each observed difference here and rewrite and re-verify the proposal architecture before submission rather than weakening acceptance criteria. It is `mobile-blocked` when the mobile platform remains blocked after a retest, and then the fallback candidate requires a separate proof before any submission.

Current outcome: `pending`.

## Screen recording

I will link a screen recording of the macOS and iPhone runs here once it is published. Recording: pending.

## Proof boundary

The committee has pushed back on demos that already contained funded work, so the boundary is a hard requirement of the proof and CI enforces part of it. Quoted from the proposal:

> The proof will not implement automatic vault watching, durable descriptors or head anchors, reconciliation, conflict copies, tombstone retention, compaction, cache-loss recovery, production enrollment or retirement, product UI, or release hardening.

| Boundary item | Status | How the repository shows it |
|---|---|---|
| Automatic vault watching | not implemented | no Vault, MetadataCache or Workspace event handler; `vault.on(`, `workspace.on(`, `metadataCache.on(` and `registerEvent(` are denylisted in `check:boundary` |
| Durable descriptors or head anchors | not implemented | the only objects written are the three fixtures and probe objects; no object content or metadata the plugin writes contains another object id |
| Reconciliation | not implemented | the download writes fixtures into the proof folder and compares nothing with vault state |
| Conflict copies | not implemented | an existing file at the download path is replaced; no conflict file is created |
| Tombstone retention | not implemented | events are observed and recorded, never acted on |
| Compaction | not implemented | `pruneSlabs` is denylisted and no slab bookkeeping exists |
| Cache-loss recovery | not implemented | no local cache exists |
| Production enrollment or retirement | not implemented | connect with a one-time phrase display and phrase entry, plus credential removal; no device registry, controller role or retirement protocol |
| Product UI | not implemented | commands, notices, one settings field and text modals only; no ribbon icon, status bar item, view, editor extension or menu |
| Release hardening | not implemented | one size, reproducibility and checksum check; no update channel, no telemetry, no crash reporting |

Beyond the quoted list, the plugin registers no timer or background task (`setInterval(` and `registerInterval(` are denylisted; its only `setTimeout` is a cleared, command-scoped deadline), calls no sharing method, and keeps every first-party source file under `src/` so the boundary scan covers all of it.

## License

MIT, copyright Ojus Chugh. `THIRD_PARTY_NOTICES.md` retains the SDK's MIT notice.
