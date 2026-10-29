# Written by packaging/homebrew.sh for each release: do not edit.
class Dockflow < Formula
  desc "Deploy Docker Compose apps to your own servers"
  homepage "https://dockflow.shawiizz.dev"
  version "1.0.0-alpha.6"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.6/dockflow-darwin-arm64"
      sha256 "21a1c85eb922c4e187ab30a9b5d3ef4f91fcbbec1e25d68e9aa3ca6d36de597c"
    end
    on_intel do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.6/dockflow-darwin-amd64"
      sha256 "78ce38996bdbae803b982e981271561cfe933ee470d0bfa6ce525ea88fff2341"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.6/dockflow-linux-arm64"
      sha256 "6c487a8c535348572973d84ff43d6c2273f3af6ae44308a47eebb9c41421a976"
    end
    on_intel do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.6/dockflow-linux-amd64"
      sha256 "e2c0ad55fdcfec9196d38c20f23d04ec1b23c1ab9c9e3d42d297bf075e6abd89"
    end
  end

  def install
    bin.install Dir["dockflow-*"].first => "dockflow"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dockflow version")
  end
end
