# Making the public repository

How to publish Ficha's source as a clean public repository near the event.
**This is a plan: do not run it without the author's final OK.** The 2026
rules (<https://www.hackmeridian.com/build>) make the GitHub repository one
of the four things judges review, with the demo video, the pitch deck and
the submission answers, due Monday 26 October at 12:00 Lisbon time. Publish
it before hacking starts on Sunday 25 October, so the `pre-hackmeridian`
tag is dated before the event.

## Decisions first

- **Name.** A new repository, not the name of the site's repository: that
  one holds only the built site and **stays private**.
- **History.** A fresh history: one commit made from the chosen state, not
  the private history. Old commit messages and old versions of files hold
  things that were never meant for publication (another project's name,
  local paths, network addresses of the bench).
- **Commit identity.** The commit and the annotated tag both carry the
  author's identity, so set GitHub's no-reply address in the new
  repository's own git config before either (step 4): `git -c` on the
  commit alone would leave the tag with the global, personal address.
- **The earlier Rust prototype** (`core/`, `station/`, the root `Cargo.toml`
  and `Cargo.lock`) and the **internal planning documents** (the Lisbon
  checklist and the draft to the organisers) were left out: the author
  decided so on 23 October 2026, and they were removed in this private
  repository as a commit, so the export is exactly `HEAD` and step 4 can
  prove it by comparing trees. The prototype stays in the private history;
  the planning documents are kept outside the repository.

## 1. Freeze the state

From the private repository, on the commit to publish:

```bash
git status --short                 # clean: nothing modified, nothing staged
.venv/Scripts/python.exe smoke_test.py
cd app && npm test && npm run typecheck && npm run build && cd ..
# contracts/escrow, in WSL: stellar contract build && cargo test
```

Update the README's status table with the numbers the suites print.

## 2. Export only the tracked files

`git archive` takes what git tracks and nothing else, so the files git
ignores (`.env`, `sessions.jsonl`, the cursors, `.venv/`, `node_modules/`,
`target/`, `app/dist*/`, `app/android/local.properties`, `.claude/`) never
leave. Run steps 2 to 4 in one Git Bash session, from the private
repository's root:

```bash
HEAD_TREE=$(git rev-parse 'HEAD^{tree}')    # step 4 compares the export with it
mkdir ../ficha-public
git archive --format=tar HEAD | tar -x -C ../ficha-public
```

Export to `../ficha-public`, next to this repository, and **never to
`%TEMP%`** or another temporary folder: Windows Storage Sense deletes old
files there when the disk runs low, and `git archive` gives every file the
commit's date, so an export of an older commit can vanish part by part
while it is being checked.

## 3. Scan the export

In `../ficha-public`, before any `git init`. Review every hit by eye.

| Look for | Command | Expected hits |
|---|---|---|
| Stellar secret keys | `grep -rnE "\bS[A-Z2-7]{55}\b" .` | only the public SEP-5 test vectors in `app/src/wallet/sep5.test.ts` |
| Recovery words | `grep -rniE "mnemonic\|seed phrase" .` | the SEP-5 vectors and the wallet code |
| Other secrets | `grep -rniE "secret\|private.?key\|api.?key\|token=\|passw" .` | code and documentation that say secrets are never stored; no value |
| Local paths | `grep -rniE "[a-z]:[/\\]+users[/\\]\|/mnt/c/\|/home/" .` | only the `/mnt/c/<path to the repo>` placeholder in `contracts/escrow/README.md` and this table's own pattern |
| Network addresses, device serials | `grep -rnE "192\.168\.\|10\.[0-9]+\.[0-9]+\.[0-9]+" .` | documentation examples only |
| Email addresses | `grep -rnE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}" .` | the organisers' address in the hackathon documents, if kept, and GitHub's no-reply address in this file's step 4 |
| Names that must not appear | grep for each name on the author's private list | none |
| Key files | `find . \( -name "*.secret" -o -name "*.key" -o -path "*/keys/*" -o -name "*.pem" -o -name "*.p12" -o -name "*.pfx" -o -name "*.jks" -o -name "*.keystore" -o -name "keystore.properties" -o -name "google-services.json" -o -name ".env" -o -name ".env.*" ! -name "*.example" -o -name "*.jsonl" \) -print` | none (the `.env*.example` files hold no secret) |

If a secret scanner such as gitleaks or trufflehog is already installed,
run it over the folder as well (`gitleaks detect --no-git --source .`).

No secret key is in the repository. The public keys in the documents (the
demo host `GCJC2PFI…`, the registry key `GBC2MDBT…`, the deployer) are
meant to be public. The demo host's and the registry's testnet secrets
were lost on 14 October 2026, when Windows Storage Sense emptied the Temp
folder that held their only copies. Nothing the demo does needs them:
deposits, claims, releases and `pay_host` take no key of ours, and the
signed registry, the contract and both station entries stay valid past the
event. But no registry can be signed for the pinned key and no station can
be registered again as the demo host, so **the registry and the station
terms of `YX3DGE` and `ERZGCG` are frozen until after the event**; a change
would need a new registry key or a new demo host, an app rebuild and a site
republish.

## 4. Create the repository

```bash
cd ../ficha-public
git init -b main
git config user.name "Beto Rocha"           # this repository only, before the commit and the tag
git config user.email "177217792+beto-rocha-blockchain@users.noreply.github.com"
git add -A
git update-index --chmod=+x app/android/gradlew   # on Windows, git add records it as 100644
git status                          # read the whole list once
if test -n "$HEAD_TREE" && test "$(git write-tree)" = "$HEAD_TREE"; then
  echo "same tree as the private HEAD"
  git commit -m "Ficha: the state brought to HackMeridian 2026"
  git tag -a pre-hackmeridian -m "Ficha before HackMeridian 2026 (Scale path)"
else
  echo "STOP: the export is not the private HEAD's tree"
fi
git cat-file -p pre-hackmeridian | grep tagger          # the no-reply address only
git log -1 --format='%an <%ae>, %cn <%ce>'              # the same, as author and committer
```

A STOP means the export is not `HEAD`: a file left out outside a commit, a
line ending, a file mode, or `HEAD_TREE` lost with another shell. The app's
test `src/native/android-gradlew.test.ts` checks the gradlew bit inside
git.

Only with the author's OK, create it on GitHub and push:

```bash
gh repo create <owner>/<name> --public --source . --push
git push origin pre-hackmeridian
```

## 5. After publishing

- Repository settings: the description (the README's first sentence), the
  website <https://ficha-stellar.vercel.app>, topics (`stellar`, `soroban`,
  `hackathon`).
- Check on GitHub: the README's mermaid diagrams render, its images load,
  the licence shows as MIT, and every relative link opens.
- Work done during the event goes into this repository after the tag, in
  small dated commits, so what changed at the event is plain to see.
- The private repository keeps its full history as the record. The site's
  repository stays private, and no token or deploy key for it goes into the
  public one.
