{
  lib,
  stdenv,
  callPackage,
  craneLib,
  bun,
  nodejs,
  pkg-config,
  cargo-tauri,
  wrapGAppsHook3,
  makeBinaryWrapper,
  dbus,
  webkitgtk_4_1,
  glib-networking,
  gst_all_1,
  xdg-utils,
  writeText,
}:
let
  inherit (stdenv.hostPlatform) isLinux isDarwin;
  version = (builtins.fromTOML (builtins.readFile ../Cargo.toml)).package.version;
  rustFiles = lib.fileset.unions [
    ../Cargo.toml
    ../Cargo.lock
    ../build.rs
    ../src
    ../crates
    ../capabilities
    ../icons
    ../tauri.conf.json
  ];
  rustSource = lib.fileset.toSource {
    root = ../.;
    fileset = rustFiles;
  };
  webSource = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      rustFiles
      ../web
    ];
  };
  nodeModules = callPackage ./bun-deps.nix {
    src = lib.fileset.toSource {
      root = ../web;
      fileset = lib.fileset.unions [
        ../web/package.json
        ../web/bun.lock
        ../web/patches
      ];
    };
  };
  wasmBindgen = callPackage ./wasm-bindgen.nix { };
  tauriHook = cargo-tauri.hook.override { cargo = craneLib.cargo; };
  cargoVendorDir = craneLib.vendorCargoDeps { cargoLock = ../Cargo.lock; };
  common = {
    pname = "celestite";
    inherit version cargoVendorDir;
    src = rustSource;
    strictDeps = true;
    doCheck = false;
    CARGO_NET_OFFLINE = "true";
  };
  wasmArtifacts = craneLib.buildDepsOnly (
    common
    // {
      pname = "celestite-wasm-deps";
      cargoExtraArgs = "--locked -p celestite-core --features wasm,preview --target wasm32-unknown-unknown";
    }
  );
  frontend = craneLib.mkCargoDerivation (
    common
    // {
      pname = "celestite-web";
      src = webSource;
      cargoArtifacts = wasmArtifacts;
      doInstallCargoArtifacts = false;
      nativeBuildInputs = [
        bun
        nodejs
        wasmBindgen
      ];
      CARGO_TARGET_DIR = "target";
      WASM_BINDGEN = "${wasmBindgen}/bin/wasm-bindgen";
      preConfigure = ''
        cp -R ${nodeModules} web/node_modules
        chmod -R u+w web/node_modules
        patchShebangs web/node_modules
      '';
      buildPhaseCargoCommand = "bun run --cwd web build";
      doCheck = true;
      checkPhaseCargoCommand = ''
        cd web
        node_modules/.bin/tsc --noEmit
        node_modules/.bin/tsc --noEmit -p tsconfig.node.json
        bun test tests/unit
        cd ..
      '';
      installPhaseCommand = "cp -R web/dist $out";
    }
  );
  nativeArgs = common // {
    # Match Tauri's build hook so the dependency artifacts remain reusable.
    CARGO_PROFILE_RELEASE_STRIP = "false";
    CARGO_BUILD_TARGET = stdenv.hostPlatform.rust.rustcTarget;
    "CARGO_TARGET_${stdenv.hostPlatform.rust.cargoEnvVarTarget}_LINKER" =
      "${stdenv.cc}/bin/${stdenv.cc.targetPrefix}cc";
    "CC_${stdenv.hostPlatform.rust.cargoEnvVarTarget}" = "${stdenv.cc}/bin/${stdenv.cc.targetPrefix}cc";
    "CXX_${stdenv.hostPlatform.rust.cargoEnvVarTarget}" =
      "${stdenv.cc}/bin/${stdenv.cc.targetPrefix}c++";
    HOST_CC = "${stdenv.cc}/bin/cc";
    HOST_CXX = "${stdenv.cc}/bin/c++";
    cargoExtraArgs = "--locked -p celestite --features custom-protocol --target ${stdenv.hostPlatform.rust.rustcTarget}";
    nativeBuildInputs = [
      pkg-config
      tauriHook
    ]
    ++ lib.optionals isLinux [ wrapGAppsHook3 ]
    ++ lib.optionals isDarwin [ makeBinaryWrapper ];
    buildInputs = lib.optionals isLinux [
      dbus
      webkitgtk_4_1
      glib-networking
      gst_all_1.gst-plugins-base
    ];
  };
  tauriConfig = writeText "celestite-nix-tauri.json" (
    builtins.toJSON {
      build = {
        beforeBuildCommand = null;
        frontendDist = "${frontend}";
      };
    }
  );
in
craneLib.buildPackage (
  nativeArgs
  // {
    cargoArtifacts = craneLib.buildDepsOnly nativeArgs;
    buildPhase = "tauriBuildHook";
    installPhase = "tauriInstallHook";
    doNotPostBuildInstallCargoBinaries = true;
    cargoBuildFlags = [ "--locked" ];
    tauriBuildFlags = [
      "--config"
      tauriConfig
    ];
    postInstall = lib.optionalString isDarwin ''
      mkdir -p "$out/bin"
      makeWrapper "$out/Applications/celestite.app/Contents/MacOS/celestite" "$out/bin/celestite"
    '';
    preFixup = lib.optionalString isLinux ''
      gappsWrapperArgs+=(--prefix PATH : ${lib.makeBinPath [ xdg-utils ]})
    '';
    passthru = { inherit frontend nodeModules wasmBindgen; };
    meta = {
      description = "A markup noting app based on Notist";
      mainProgram = "celestite";
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
    };
  }
)
