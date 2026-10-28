package cli

import (
	"testing"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/testutil"
)

func TestPlanMarkdown(t *testing.T) {
	p := &domain.Plan{
		Actions: []domain.Action{
			{Kind: domain.ActionCreateService, Target: "worker", Reason: "new service"},
			{Kind: domain.ActionUpdateService, Target: "web", Strategy: "start-first", Reason: "image: shop/web:1 | shop/web:2"},
			{Kind: domain.ActionUpload, Target: "/etc/nginx/sites-enabled/shop.conf", Reason: "changed"},
		},
		Unchanged: []string{"db"},
		Summary:   domain.Summary{Create: 1, Update: 1},
		Warnings:  []string{"db: no health check"},
	}
	testutil.GoldenText(t, "plan.md", planMarkdown("shop", "production", "main", "1.4.0", p, []string{"compose: version is obsolete"}))
	testutil.GoldenText(t, "plan-empty.md", planMarkdown("shop", "production", "main", "1.4.0", &domain.Plan{}, nil))
}
