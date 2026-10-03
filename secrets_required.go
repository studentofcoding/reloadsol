package main

import "fmt"

// validateRequiredSecrets makes a missing TRENDING_TRACKER_SECRET a startup failure. There is no built-in
// default: every cron job authenticates to the web app with ?key=<TrendingSecret>, so running without it
// can only produce a stream of 401s (or, with a committed default, a publicly known credential).
func validateRequiredSecrets(c *Config) error {
	if c == nil || c.TrendingSecret == "" {
		return fmt.Errorf("TRENDING_TRACKER_SECRET is required (no default). Set it in .env")
	}
	return nil
}
