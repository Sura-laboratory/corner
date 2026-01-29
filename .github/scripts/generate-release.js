#!/usr/bin/env node

const { execSync } = require('child_process');
const { Octokit } = require('@octokit/rest');
const semver = require('semver');

const token = process.env.GITHUB_TOKEN;
const repoFull = process.env.GITHUB_REPOSITORY; // owner/repo
const prNumber = process.env.PR_NUMBER;

if (!token) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}
if (!repoFull) {
  console.error('GITHUB_REPOSITORY is required');
  process.exit(1);
}
if (!prNumber) {
  console.error('PR_NUMBER is required');
  process.exit(1);
}

const [owner, repo] = repoFull.split('/');

const octokit = new Octokit({ auth: token });

async function getLatestTag() {
  try {
    // ensure tags are available locally (actions/checkout with fetch-depth: 0 should have them)
    // fallback to GitHub API if git tags missing
    const localTags = execSync('git tag --list --sort=-v:refname', { encoding: 'utf8' }).split('\n').map(t => t.trim()).filter(Boolean);
    if (localTags.length > 0) {
      return localTags[0];
    }
  } catch (e) {
    // ignore and try API
  }

  // fallback via API
  try {
    const resp = await octokit.repos.listTags({ owner, repo, per_page: 1 });
    if (resp.data && resp.data.length > 0) {
      return resp.data[0].name;
    }
  } catch (e) {
    // ignore
  }

  return null;
}

function normalizeTag(tag) {
  if (!tag) return null;
  // strip leading 'v' or 'V'
  return tag.replace(/^v/i, '');
}

function detectBumpFromPR(pr) {
  // Priority: label major/minor/patch > breaking in title/body > conventional commit in title > default patch
  const labels = (pr.labels || []).map(l => (l.name || '').toLowerCase());

  if (labels.some(l => l.includes('major'))) return 'major';
  if (labels.some(l => l.includes('minor'))) return 'minor';
  if (labels.some(l => l.includes('patch') || l.includes('bug'))) return 'patch';

  const title = (pr.title || '').toLowerCase();
  const body = (pr.body || '').toLowerCase();

  // Breaking change detection
  if (body.includes('breaking change') || title.includes('breaking change')) return 'major';
  // "!" in conventional commit header: e.g., feat!: ...
  if (/^[a-z]+.*![:(]/i.test(pr.title || '')) return 'major';

  // conventional commit type detection in title
  if (/^feat(\(|:)/i.test(pr.title || '')) return 'minor';
  if (/^fix(\(|:)/i.test(pr.title || '')) return 'patch';

  // default to patch
  return 'patch';
}

async function buildReleaseNotes(pr) {
  const lines = [];
  lines.push(`# ${pr.title || 'Pull Request'}\n`);
  lines.push(`- PR: [#${pr.number}](${pr.html_url})`);
  lines.push(`- Author: @${pr.user.login}`);
  lines.push(`- Branch: ${pr.head.ref}`);
  lines.push('');

  if (pr.body) {
    lines.push('## Description\n');
    lines.push(pr.body);
    lines.push('');
  }

  // list commits (up to 50)
  try {
    const commitsResp = await octokit.pulls.listCommits({ owner, repo, pull_number: pr.number, per_page: 100 });
    if (commitsResp.data && commitsResp.data.length > 0) {
      lines.push('## Commits\n');
      for (const c of commitsResp.data.slice(0, 50)) {
        const shortSha = c.sha.slice(0, 7);
        const messageFirstLine = (c.commit && c.commit.message) ? c.commit.message.split('\n')[0] : '';
        lines.push(`- ${messageFirstLine} (${shortSha}) — @${c.author ? c.author.login : c.commit.author.name}`);
      }
      lines.push('');
    }
  } catch (e) {
    // ignore
  }

  // list files changed
  try {
    const filesResp = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number, per_page: 200 });
    if (filesResp.data && filesResp.data.length > 0) {
      lines.push('## Files changed\n');
      for (const f of filesResp.data) {
        lines.push(`- ${f.filename} (+${f.additions}/-${f.deletions})`);
      }
      lines.push('');
    }
  } catch (e) {
    // ignore
  }

  // capture referenced/closes issues from body
  const closingIssues = [];
  const closeRegex = /(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/ig;
  let m;
  while ((m = closeRegex.exec(pr.body || '')) !== null) {
    closingIssues.push(m[2]);
  }
  if (closingIssues.length) {
    lines.push('## Closes\n');
    for (const num of new Set(closingIssues)) {
      lines.push(`- #${num}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

(async () => {
  try {
    // fetch PR info
    const prResp = await octokit.pulls.get({ owner, repo, pull_number: parseInt(prNumber, 10) });
    const pr = prResp.data;

    // determine latest tag
    const latestTagRaw = await getLatestTag();
    const latestTag = normalizeTag(latestTagRaw) || '0.0.0';
    if (!semver.valid(latestTag)) {
      // in case tag isn't a semver, fallback to 0.0.0
      console.warn(`Latest tag "${latestTagRaw}" is not semver; defaulting to 0.0.0`);
    }
    const base = semver.valid(latestTag) ? latestTag : '0.0.0';

    const bump = detectBumpFromPR(pr);
    const next = semver.inc(base, bump);
    if (!next) {
      console.error('Failed to compute next semver version');
      process.exit(1);
    }
    const nextTag = `v${next}`;

    console.log(`Latest tag: ${latestTagRaw || 'none'} -> base ${base}`);
    console.log(`Detected bump: ${bump} -> next version ${nextTag}`);

    const body = await buildReleaseNotes(pr);

    // check if release with this tag already exists
    let existingRelease = null;
    try {
      const listResp = await octokit.repos.listReleases({ owner, repo, per_page: 100 });
      existingRelease = listResp.data.find(r => r.tag_name === nextTag);
    } catch (e) {
      // ignore
    }

    if (existingRelease) {
      console.log(`Updating existing release ${nextTag} (id: ${existingRelease.id})`);
      await octokit.repos.updateRelease({
        owner,
        repo,
        release_id: existingRelease.id,
        tag_name: nextTag,
        name: `${nextTag} (draft)`,
        body,
        draft: true,
        prerelease: false
      });
      console.log(`Updated draft release ${nextTag}`);
    } else {
      // create the release as a draft pointing at PR head sha so reviewer can download assets if needed
      const target_sha = pr.head.sha;
      console.log(`Creating draft release ${nextTag} targeting ${target_sha}`);
      await octokit.repos.createRelease({
        owner,
        repo,
        tag_name: nextTag,
        name: `${nextTag} (draft)`,
        body,
        draft: true,
        prerelease: false,
        target_commitish: target_sha
      });
      console.log(`Created draft release ${nextTag}`);
    }
  } catch (err) {
    console.error('Error while creating/updating release:', err);
    process.exit(1);
  }
})();