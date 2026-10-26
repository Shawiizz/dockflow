package ci

import "testing"

func TestDetect(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want Run
	}{
		{"none", map[string]string{}, Run{}},
		{"github tag", map[string]string{"GITHUB_ACTIONS": "true", "GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": "1.2.0", "GITHUB_SHA": "abc", "GITHUB_ACTOR": "me"},
			Run{Provider: "github", Tag: "1.2.0", SHA: "abc", Actor: "me"}},
		{"github branch", map[string]string{"GITHUB_ACTIONS": "true", "GITHUB_REF_TYPE": "branch", "GITHUB_REF_NAME": "main"},
			Run{Provider: "github", Branch: "main"}},
		{"gitlab", map[string]string{"GITLAB_CI": "true", "CI": "true", "CI_COMMIT_TAG": "1.2.0-staging", "CI_COMMIT_SHA": "abc", "GITLAB_USER_LOGIN": "me"},
			Run{Provider: "gitlab", Tag: "1.2.0-staging", SHA: "abc", Actor: "me"}},
		{"buildkite tag", map[string]string{"BUILDKITE": "true", "CI": "true", "BUILDKITE_TAG": "1.2.0", "BUILDKITE_BRANCH": "1.2.0", "BUILDKITE_BUILD_CREATOR": "Me"},
			Run{Provider: "buildkite", Tag: "1.2.0", Actor: "Me"}},
		{"bitbucket", map[string]string{"BITBUCKET_BUILD_NUMBER": "7", "BITBUCKET_BRANCH": "main", "BITBUCKET_COMMIT": "abc"},
			Run{Provider: "bitbucket", Branch: "main", SHA: "abc"}},
		{"jenkins", map[string]string{"JENKINS_URL": "http://ci", "TAG_NAME": "1.2.0", "GIT_COMMIT": "abc"},
			Run{Provider: "jenkins", Tag: "1.2.0", SHA: "abc"}},
		{"other", map[string]string{"CI": "true"}, Run{Provider: "ci"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Detect(func(k string) string { return c.env[k] }); got != c.want {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}
