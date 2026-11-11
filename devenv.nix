{
  pkgs,
  lib,
  config,
  ...
}:

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

  # clang-tidy on the given C files, or on all of src/c when given none or a
  # header. Runs from git hooks too, so it doesn't rely on the shell's PATH.
  lintC = pkgs.writeShellApplication {
    name = "lint-c";
    # Unwrapped: the nixpkgs wrapper adds the host's glibc headers.
    runtimeInputs = [ pkgs.llvmPackages.clang-unwrapped ];
    text = ''
      cd ${config.devenv.root}
      # waf and clang read these, and a parent shell may export them.
      unset CC AR CPATH C_INCLUDE_PATH
      # pebble runs python3 from PATH; git may call this hook outside the shell.
      export PATH="${config.env.DEVENV_STATE}/venv/bin:$PATH"

      files=()
      for f in "$@"; do
        case $f in
          *.c) files+=("$f") ;;
          # A header can change the result for any .c file.
          *) files=(); break ;;
        esac
      done
      if [ ''${#files[@]} -eq 0 ]; then files=(src/c/*.c); fi

      db=compile_commands.json
      fresh=1
      if [ ! -f "$db" ] || [ package.json -nt "$db" ] || [ wscript -nt "$db" ]; then
        fresh=0
      else
        for f in "''${files[@]}"; do
          grep -qF "\"$PWD/$f\"" "$db" || { fresh=0; break; }
        done
      fi
      if [ "$fresh" = 0 ] && ! out=$(pebble compile-commands 2>&1); then
        printf '%s\n' "$out" >&2
        exit 1
      fi

      tmp=$(mktemp -d)
      trap 'rm -rf "$tmp"' EXIT
      pids=()
      for f in "''${files[@]}"; do
        clang-tidy -p . --quiet "$f" >"$tmp/''${f//\//_}.log" 2>&1 &
        pids+=("$!")
      done
      status=0
      for pid in "''${pids[@]}"; do wait "$pid" || status=1; done
      grep -hvE '^([0-9]+ (warnings?|errors?)( and [0-9]+ errors?)? generated\.|Error while processing .*)$' "$tmp"/*.log || true
      exit "$status"
    '';
  };
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

  packages = [ lintC ];

  scripts.lint = {
    description = "clang-tidy on src/c, then Biome on the JS, HTML and CSS";
    exec = ''
      cd ${config.devenv.root}
      status=0
      lint-c || status=1
      ${lib.getExe pkgs.biome} lint || status=1
      exit "$status"
    '';
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
      biome = {
        enable = true;
        # Report findings; fixing them stays a deliberate step.
        settings.write = false;
        settings.flags = "--no-errors-on-unmatched --files-ignore-unknown=true";
        # Adds html for the inline script and CSS in src/config.html.
        types_or = lib.mkForce [
          "javascript"
          "json"
          "html"
        ];
      };
      lint-c = {
        enable = true;
        name = "clang-tidy";
        entry = lib.getExe lintC;
        files = "^src/c/.*\\.[ch]$";
      };
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
