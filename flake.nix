{
  description = "Inbox review cockpit prototype";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (
          system:
          let
            pkgs = import nixpkgs { inherit system; };
          in
          f { inherit pkgs system; }
        );
    in
    {
      devShells = forAllSystems (
        { pkgs, ... }:
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              git
              jq
              ripgrep
              just
              curl
            ];

            shellHook = ''
              export INBOX_BROWSER_CACHE="$PWD/.playwright-browsers"
              export PLAYWRIGHT_BROWSERS_PATH="$INBOX_BROWSER_CACHE"
              export npm_config_cache="$PWD/.npm"
            '';
          };
        }
      );

      apps = forAllSystems (
        { pkgs, system }:
        let
          mkRunner =
            name: command:
            pkgs.writeShellApplication {
              inherit name;
              runtimeInputs = [ pkgs.nodejs_24 pkgs.git pkgs.just ];
              text = ''
                cd "$PWD"
                exec ${command}
              '';
            };
        in
        {
          dev = {
            type = "app";
            program = "${mkRunner "inbox-dev" "just dev"}/bin/inbox-dev";
          };
          validate = {
            type = "app";
            program = "${mkRunner "inbox-validate" "just validate"}/bin/inbox-validate";
          };
          default = self.apps.${system}.dev;
        }
      );

      formatter = forAllSystems ({ pkgs, ... }: pkgs.nixfmt-rfc-style);
    };
}
