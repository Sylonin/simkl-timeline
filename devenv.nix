{ pkgs, lib, ... }:

let
  # Shared libraries that the SDK's prebuilt qemu-pebble loads through nix-ld.
  emulatorLibs = with pkgs; [
    zlib
    pixman
    libpng
    SDL2
    glib
    alsa-lib
    libpulseaudio
  ];
in
{
  # The SDK compiles with its own arm-none-eabi toolchain, but waf takes $CC
  # and $AR from the environment first, so keep the host compiler out.
  stdenv = pkgs.stdenvNoCC;

  # Runs the plugin tests; `pebble build` also runs `npm install`.
  languages.javascript = {
    enable = true;
    npm.enable = true;
  };

  # pebble-tool from PyPI. It keeps SDKs in ~/.local/share/pebble-sdk, so a new
  # machine still needs `pebble sdk install latest` once. The tool and the SDK's
  # waf are tested on Python 3.12; nixpkgs' default is newer.
  languages.python = {
    enable = true;
    package = pkgs.python312;
    # Its PyPI wheels (greenlet, numpy) link libstdc++ and zlib.
    manylinux.enable = true;
    uv.enable = true;
    venv = {
      enable = true;
      quiet = true;
      requirements = "pebble-tool==5.1.2";
    };
  };

  enterShell = ''
    # A parent shell, such as another devenv, may still export them.
    unset CC AR
    export NIX_LD_LIBRARY_PATH="${lib.makeLibraryPath emulatorLibs}''${NIX_LD_LIBRARY_PATH:+:$NIX_LD_LIBRARY_PATH}"
  '';

  git-hooks = {
    hooks = {
      ripsecrets.enable = true;
      treefmt.enable = true;
    };
    package = pkgs.prek;
  };

  treefmt = {
    enable = true;
    config.settings.excludes = [ ".envrc" ];
    config.programs.nixfmt.enable = true;
  };

  # Format through the pre-commit hook only, not on every shell entry.
  tasks."devenv:treefmt:run".before = lib.mkForce [ ];
}
