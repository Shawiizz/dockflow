# Written by packaging/homebrew.sh for each release: do not edit.
class Dockflow < Formula
  desc "Deploy Docker Compose apps to your own servers"
  homepage "https://dockflow.shawiizz.dev"
  version "1.0.0-alpha.5"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.5/dockflow-darwin-arm64"
      sha256 "a4b0f25a7f8dec1afd948d0607110d498f7b36265e94127af3418239057f1cbe"
    end
    on_intel do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.5/dockflow-darwin-amd64"
      sha256 "37d1e00b6c586f1e39a0824c051e514d0f96ccaa4aa4ebc1bbf5ccf28a968982"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.5/dockflow-linux-arm64"
      sha256 "7711937b58ee4a2dd70da312ca6ed95d483fa1fdc71d851ec02a124b3a17e80d"
    end
    on_intel do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.5/dockflow-linux-amd64"
      sha256 "78583e140ef85c7ce3adef769940dd7e835d6365f5b98d1169711b41bd020bea"
    end
  end

  def install
    bin.install Dir["dockflow-*"].first => "dockflow"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dockflow version")
  end
end
