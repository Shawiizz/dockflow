# Written by packaging/homebrew.sh for each release: do not edit.
class Dockflow < Formula
  desc "Deploy Docker Compose apps to your own servers"
  homepage "https://dockflow.shawiizz.dev"
  version "1.0.0-alpha.4"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.4/dockflow-darwin-arm64"
      sha256 "382ddf53be2689927cdf3ead87a032a9745ef45f1ffb56a638550f13ee528597"
    end
    on_intel do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.4/dockflow-darwin-amd64"
      sha256 "454fe013afb8d63033950276bb4b838be09b460134a25bc17e3ed163e2665892"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.4/dockflow-linux-arm64"
      sha256 "2aa2aac94d8920a7f6d40764e813d6d9d4c2596f9edf9bceac1fa2f9d9410aa6"
    end
    on_intel do
      url "https://github.com/Shawiizz/dockflow/releases/download/v1.0.0-alpha.4/dockflow-linux-amd64"
      sha256 "ddde14204be7a40fb0ccc6cbc1faa70d2f34a5b402fea35205ca1b20d22a483e"
    end
  end

  def install
    bin.install Dir["dockflow-*"].first => "dockflow"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dockflow version")
  end
end
