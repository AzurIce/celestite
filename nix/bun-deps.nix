{
  lib,
  stdenvNoCC,
  bun,
  cacert,
  writableTmpDirAsHomeHook,
  src,
  hash ? "sha256-fVx7K25El7hIatB45Xv/iOzN9EW5mwDtq6EPg/Npn6k=",
}:

# src is the web package root: package.json, bun.lock and patches only.
# Lifecycle scripts are excluded; syntax grammars are already checked in.
stdenvNoCC.mkDerivation {
  pname = "celestite-bun-deps";
  version = "0.1.0";
  inherit src;

  nativeBuildInputs = [
    bun
    cacert
    writableTmpDirAsHomeHook
  ];
  impureEnvVars = lib.fetchers.proxyImpureEnvVars;

  dontConfigure = true;
  dontFixup = true;
  dontPatchShebangs = true;

  buildPhase = ''
    runHook preBuild
    export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
    bun install \
      --frozen-lockfile \
      --ignore-scripts \
      --no-progress \
      --linker=hoisted \
      --backend=copyfile \
      --registry=https://registry.npmjs.org \
      --os='*' \
      --cpu='*'
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cp -R node_modules "$out"
    runHook postInstall
  '';

  outputHash = hash;
  outputHashAlgo = "sha256";
  outputHashMode = "recursive";
}
