# Measurement records

This folder holds one JSON file per proof run. I do not write these files on the device. The plugin writes one JSON record per command into `foliospindle-proof/records` inside the test vault, and I assemble a measurement record from those files afterwards on the Mac with `node scripts/assemble-measurement.mjs`. Nothing in this folder is written by hand.

## File names

Each file is named `<label>-<date>.json`. The label names the platform and the date is the run date in `YYYY-MM-DD` form. The three labels are `macos`, `ios` and `android-emulator`, so a complete run produces files like `macos-2026-10-12.json`, `ios-2026-10-12.json` and `android-emulator-2026-10-13.json`, with the dates replaced by the days the runs happened. The top-level README lists a platform as tested only when its file is committed here and carries a value for every field named below.

## Labels

The `labels` array in each record starts with the platform label. The Android emulator record also carries the tags `emulator` and `secondary`: `emulator` because it is not a physical device, and `secondary` because the proof commits to the Mac and the iPhone and the emulator run is a secondary data point. The Mac and iPhone records carry only their platform label.

## Collecting the records

On the Mac the records are already on disk. The vault `FolioSpindle Proof Mac` is a plain folder, so I point the script at `<vault>/foliospindle-proof/records` directly.

On the iPhone I connect the phone by USB, open Finder, select the phone, open the Files tab, open Obsidian, open the vault `FolioSpindle Proof iPhone` and drag the `foliospindle-proof/records` folder to the Mac. Selecting the folder in the Files app and sharing it to the Mac with AirDrop works as well.

On the Android emulator I run `adb pull` on the vault folder and point the script at its `foliospindle-proof/records` subfolder. The emulator runs as a further installation and enters the same application phrase as the iPhone.

## Assembling a record

The command is `node scripts/assemble-measurement.mjs --records <dir> --label <label> --device "<model>" --os "<version>" --date YYYY-MM-DD`, with `--tag emulator --tag secondary` added for the emulator. I supply `--os` by hand on macOS because the runtime does not expose the version. I add `--entered <receipt.json>` to pass the other installation's receipt, saved exactly as I pasted it into the plugin, so the measurement can embed it as `receipts.entered`; the script insists on it whenever a cross-installation download or a probe authority result is present. The script picks the latest record per command, takes both download records (one with the device's own receipt and one with the receipt from the other installation) and the events record that carries the probe authority steps, and checks that every record agrees on the `main.js` hash, the plugin version and the SDK version. It then writes `measurements/<label>-<date>.json` and prints an advisory summary of gates G1 to G5 that I copy into the top-level README by hand.

The script refuses to write a file when any required field is missing and names the missing fields instead. The required fields are the device model, the operating system version, the Obsidian version, the plugin version, the SDK version, the `main.js` byte size and SHA-256 hash, the WASM initialization duration, the capability check output, the connect outcome with the public key of the application key, the reconnect outcome after a restart, the credential removal outcome, the per-object upload duration and byte length, the per-object download duration, the hash comparison results, the peak memory during upload or `not measured` with the reason, the event observations, the probe object authority results and the run date. An empty public key counts as missing. The `sources` array in the output lists the record files the measurement was built from.

## Object events

Every record describes the object event feed as a `coalesced current-state feed`. The `events.description` field carries that exact phrase, and the observations next to it record what the feed returned for one probe object across the create, update, deletion and incremental passes.
