# Written by packaging/homebrew.sh for each release: do not edit.
class Dockflow < Formula
  desc "Deploy Docker Compose apps to your own servers"
  homepage "https://dockflow.shawiizz.dev"
  version "1.0.0-alpha.3"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.3/dockflow-darwin-arm64"
      sha256 "9d57e9478ea446a73400ba0f0e94b8b8f5ccc63c98a50aea7c33face39b27c3a"
    end
    on_intel do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.3/dockflow-darwin-amd64"
      sha256 "d558a2f44ba8e9e4865ee175b85b288cca7e18c4f110d7f17da132d0dabeffa8"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.3/dockflow-linux-arm64"
      sha256 "fdb5db09d19bf63a4d9761a2d865a60c8c990c4088d8f877455e05b51f33a88c"
    end
    on_intel do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.3/dockflow-linux-amd64"
      sha256 "179a243ec46e6631ee2fc00522a6869fcb35170050aa087c104c74096333c768"
    end
  end

  def install
    bin.install Dir["dockflow-*"].first => "dockflow"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dockflow version")
  end
end
