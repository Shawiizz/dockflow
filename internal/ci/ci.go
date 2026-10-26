// Package ci recognises the CI provider a command runs in, and reads what it says about the run:
// the tag or branch, the commit and who started it.
package ci

// Run is a CI run.
type Run struct {
	// Provider is github, gitlab, jenkins, buildkite, bitbucket or ci (another one); empty
	// outside CI.
	Provider string
	Tag      string
	Branch   string
	SHA      string
	Actor    string
}

// Detect reads the run from the environment.
func Detect(getenv func(string) string) Run {
	switch {
	case getenv("GITHUB_ACTIONS") == "true":
		r := Run{Provider: "github", SHA: getenv("GITHUB_SHA"), Actor: getenv("GITHUB_ACTOR")}
		if getenv("GITHUB_REF_TYPE") == "tag" {
			r.Tag = getenv("GITHUB_REF_NAME")
		} else {
			r.Branch = first(getenv("GITHUB_HEAD_REF"), getenv("GITHUB_REF_NAME"))
		}
		return r
	case getenv("GITLAB_CI") == "true":
		return Run{Provider: "gitlab", Tag: getenv("CI_COMMIT_TAG"), Branch: getenv("CI_COMMIT_BRANCH"),
			SHA: getenv("CI_COMMIT_SHA"), Actor: getenv("GITLAB_USER_LOGIN")}
	case getenv("BUILDKITE") == "true":
		return Run{Provider: "buildkite", Tag: getenv("BUILDKITE_TAG"), Branch: branchUnlessTag(getenv("BUILDKITE_BRANCH"), getenv("BUILDKITE_TAG")),
			SHA: getenv("BUILDKITE_COMMIT"), Actor: first(getenv("BUILDKITE_BUILD_CREATOR"), getenv("BUILDKITE_BUILD_AUTHOR"))}
	case getenv("BITBUCKET_BUILD_NUMBER") != "":
		return Run{Provider: "bitbucket", Tag: getenv("BITBUCKET_TAG"), Branch: getenv("BITBUCKET_BRANCH"),
			SHA: getenv("BITBUCKET_COMMIT"), Actor: getenv("BITBUCKET_STEP_TRIGGERER_UUID")}
	case getenv("JENKINS_URL") != "":
		// multibranch pipelines set TAG_NAME for tags, BRANCH_NAME otherwise
		return Run{Provider: "jenkins", Tag: getenv("TAG_NAME"), Branch: first(getenv("BRANCH_NAME"), getenv("GIT_BRANCH")),
			SHA: getenv("GIT_COMMIT"), Actor: getenv("BUILD_USER_ID")}
	case getenv("CI") != "":
		return Run{Provider: "ci"}
	}
	return Run{}
}

func first(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// branchUnlessTag: Buildkite sets the branch to the tag on tag builds.
func branchUnlessTag(branch, tag string) string {
	if tag != "" && branch == tag {
		return ""
	}
	return branch
}
