{
  description = "";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    crane.url = "github:ipetkov/crane";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      rust-overlay,
      crane,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };
        craneLib = (crane.mkLib pkgs).overrideToolchain (
          p:
          p.rust-bin.nightly."2026-10-01".default.override {
            targets = [ "wasm32-unknown-unknown" ];
            extensions = [
              "rust-src"
              "rustfmt"
              "clippy"
            ];
          }
        );
      in
      {

        devShells.default = craneLib.devShell {
          buildInputs = with pkgs; [
            dbus
            librsvg
            webkitgtk_4_1
          ];

          packages = with pkgs; [
            bun
            cargo-tauri
            pkg-config
            wrapGAppsHook4
            gst_all_1.gst-plugins-base # Optional, if you get `GStreamer element appsink not found. Please install it.`
          ];

          shellHook = ''
            export XDG_DATA_DIRS="$GSETTINGS_SCHEMAS_PATH" # Needed on Wayland to report the correct display scale

            # Work around an NVIDIA EGL + Wayland explicit-sync bug.
            #
            # Without this, `cargo tauri dev` dies with:
            #   Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.
            # and, under WAYLAND_DEBUG=1:
            #   wl_display#1.error(wp_linux_drm_syncobj_surface_v1#38, 4, "Missing acquire timeline")
            #
            # The NVIDIA EGL driver binds wp_linux_drm_syncobj_manager_v1 (added in the
            # 555.x branch), then commits the surface without setting an acquire timeline
            # point, which the protocol forbids -- Hyprland raises a fatal protocol error
            # and kills the connection, so the window never maps.
            #
            # This makes the driver fall back to implicit sync. DMABUF presentation is
            # kept, so the app is still hardware accelerated.
            export __NV_DISABLE_EXPLICIT_SYNC=1
            # If a future NVIDIA driver still breaks, this drops WebKitGTK's DMABUF
            # renderer (software path, no EGL buffers at all) -- confirmed working too,
            # but slower:
            # export WEBKIT_DISABLE_DMABUF_RENDERER=1
          '';
        };
      }
    );
}
