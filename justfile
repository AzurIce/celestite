# Serve ../notist/docs as a Vault for the local Web development client.
serve-notist share_key:
    cargo run -p celestite-server -- \
        --no-config \
        --listen 127.0.0.1:7437 \
        --allowed-origin http://localhost:1420 \
        --allowed-origin http://127.0.0.1:1420 \
        --vault notist=../notist/docs \
        --vault-share-key notist={{quote(share_key)}} \
        --vault-name 'notist=notist docs' \
        --vault-state-dir notist=.celestite-state/notist

# Initialize once; preserves ../notist/docs and refuses to replace existing history.
init-notist share_key:
    mkdir -p .celestite-state/notist
    cargo run -p celestite-server -- \
        --no-config \
        --vault notist=../notist/docs \
        --vault-share-key notist={{quote(share_key)}} \
        --vault-state-dir notist=.celestite-state/notist \
        --init-vault notist
