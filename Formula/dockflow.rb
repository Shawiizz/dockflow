# Written by packaging/homebrew.sh for each release: do not edit.
class Dockflow < Formula
  desc "Deploy Docker Compose apps to your own servers"
  homepage "https://dockflow.shawiizz.dev"
  version "1.0.0-alpha.2"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.2/dockflow-darwin-arm64"
      sha256 "590508708ee60d396f0870713324225bde495b81be9ce2f03ee45aaaab36c317"
    end
    on_intel do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.2/dockflow-darwin-amd64"
      sha256 "bcc425baf74a78b87d305604c297845071c84d9299b8cd83882a21ce4a8e9f77"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.2/dockflow-linux-arm64"
      sha256 "799ec89008e45385ca9b6935d9f352ad3fde5ab69a9269e3bb497c4dce3f6d5f"
    end
    on_intel do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.2/dockflow-linux-amd64"
      sha256 "c81233a0c4ebc2ff42425ef250e57465e313991fbfa0398b0dbb09ca91d9b41d"
    end
  end

  def install
    bin.install Dir["dockflow-*"].first => "dockflow"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dockflow version")
  end
end
