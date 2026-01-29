#!/usr/bin/env node

const { Octokit } = require('@octokit/rest');
const semver = require('semver');

const token = process.env.GITHUB_TOKEN;
const repoFull = process.env.GITHUB_REPOSITORY; // owner/repo
const commitSha = process.env.GITHUB_SHA;
const actor = process.env.GITHUB_ACTOR || 'github-actions[bot]';

if (!token) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}
if (!repoFull) {
  console.error('GITHUB_REPOSITORY is required');
  process.exit(1);
}
if (!commitSha) {
  console.error('GITHUB_SHA is required');
  process.exit(1);
}

const [owner, repo] = repoFull.split('/');
const octokit = new Octokit({ auth: token });

function normalizeTag(tag) {
  if (!tag) return null;
  return tag.replace(/^v/i, '');
}

function detectBumpFromPR(pr) {
  const labels = (pr.labels || []).map(l => (l.name || '').toLowerCase());

  if (labels.some(l => l.includes('major'))) return 'major';
  if (labels.some(l => l.includes('minor'))) return 'minor';
  if (labels.some(l => l.includes('patch') || l.includes('bug'))) return 'patch';

  const title = (pr.title || '').toLowerCase();
  const body = (pr.body || '').toLowerCase();

  if (body.includes('breaking change') || title.includes('breaking change')) return 'major';
  if (/^[a-z]+.*![:(]/i.test(pr.title || '')) return 'major';
  if (/^feat(\(|:)/i.test(pr.title || '')) return 'minor';
  if (/^fix(\(|:)/i.test(pr.title || '')) return 'patch';

  return 'patch';
}

async function getLatestTag() {
  try {
    const list = await octokit.repos.listTags({ owner, repo, per_page: 100 });
    if (list.data && list.data.length > 0) {
      // sort semver-valid tags descending
      const semTags = list.data.map(t => t.name).filter(Boolean).map(n => ({ raw: n, v: normalizeTag(n) }))
        .filter(x => semver.valid(x.v))
        .sort((a, b) => semver.rcompare(a.v, b.v));
      if (semTags.length) return semTags[0].raw;
      // fallback to first tag
      return list.data[0].name;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

async function ensureAnnotatedTag(tagName, message, targetSha) {
  // tagName should include 'v' prefix ideally
  try {
    await octokit.git.getRef({ owner, repo, ref: `tags/${tagName}` });
    console.log(`Tag refs/tags/${tagName} already exists`);
    return;
  } catch (e) {
    // not found -> create annotated tag and ref
    console.log(`Creating annotated tag ${tagName} -> ${targetSha}`);
    const tagObj = await octokit.git.createTag({
      owner,
      repo,
      tag: tagName,
      message: message || `Release ${tagName}`,
      object: targetSha,
      type: 'commit',
      tagger: {
        name: actor,
        email: `${actor}@users.noreply.github.com`,
        date: new Date().toISOString()
      }
    });
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tagName}`,
      sha: tagObj.data.sha
    });
    console.log(`Annotated tag ${tagName} created (object ${tagObj.data.sha})`);
  }
}

async function findDraftReleaseForPR(prNumber) {
  try {
    const resp = await octokit.repos.listReleases({ owner, repo, per_page: 200 });
    if (!resp.data) return null;
    for (const r of resp.data) {
      if ((r.draft || false) && r.body && r.body.includes(`# ${r.name}`) === false) {
        // fallback - don't rely on this
      }
      // primary matching rule: release body contains the PR reference "- PR: [#N]" or "#N"
      if (r.body && r.body.includes(`[#${prNumber}]`)) return r;
      // secondary: name contains the tag and "(draft)" - we don't have tag here
    }
  } catch (e) {
    // ignore
  }
  return null;
}

(async () => {
  try {
    // find PRs associated with this commit
    const assoc = await octokit.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: commitSha });
    const prs = (assoc.data || []).filter(p => p.base && p.base.ref === 'main' && p.merged_at);
    if (prs.length === 0) {
      console.log('No merged PRs associated with this commit on main. Exiting.');
      return;
    }

    // Process each merged PR (usually there will be 1)
    for (const prMeta of prs) {
      // prMeta contains minimal fields; fetch full PR
      const prResp = await octokit.pulls.get({ owner, repo, pull_number: prMeta.number });
      const pr = prResp.data;

      console.log(`Processing merged PR #${pr.number}: ${pr.title}`);

      // try to find draft release created earlier for this PR
      const draftRelease = await findDraftReleaseForPR(pr.number);

      if (draftRelease) {
        console.log(`Found draft release (${draftRelease.tag_name}) for PR #${pr.number} (id: ${draftRelease.id})`);

        const tagName = draftRelease.tag_name;
        // ensure annotated tag exists for the merge commit
        try {
          await ensureAnnotatedTag(tagName, `Release ${tagName} (from PR #${pr.number})`, commitSha);
        } catch (e) {
          console.warn('Failed creating annotated tag (it might already exist):', e.message || e);
        }

        // publish release: set draft:false and update target_commitish to merged commit
        const newName = (draftRelease.name || tagName).replace(/ *\(draft\) */i, '').trim();
        await octokit.repos.updateRelease({
          owner,
          repo,
          release_id: draftRelease.id,
          tag_name: tagName,
          name: newName || tagName,
          body: draftRelease.body || `Release ${tagName}`,
          draft: false,
          prerelease: draftRelease.prerelease || false,
          // GitHub API will ignore target_commitish for updateRelease if tag exists; safe to include
          target_commitish: commitSha
        });
        console.log(`Published release ${tagName} for PR #${pr.number}`);
        continue;
      }

      // No draft release found: compute next semver from latest tag and create release
      const latestTagRaw = await getLatestTag();
      const latestTag = normalizeTag(latestTagRaw) || '0.0.0';
      const base = semver.valid(latestTag) ? latestTag : '0.0.0';
      const bump = detectBumpFromPR(pr);
      const next = semver.inc(base, bump);
      if (!next) {
        console.error('Failed to compute next semver version; skipping PR', pr.number);
        continue;
      }
      const nextTag = `v${next}`;
      console.log(`No draft found. Computed next version ${nextTag} (base ${base}, bump ${bump})`);

      // create annotated tag then create a release (published)
      try {
        await ensureAnnotatedTag(nextTag, `Release ${nextTag} (from PR #${pr.number})`, commitSha);
      } catch (e) {
        console.warn('Failed to create annotated tag:', e.message || e);
      }

      // build a simple release body referencing the PR
      const bodyLines = [];
      bodyLines.push(`# ${pr.title}`);
      bodyLines.push(`- PR: [#${pr.number}](${pr.html_url})`);
      bodyLines.push(`- Merged by: @${pr.merged_by ? pr.merged_by.login : pr.user.login}`);
      if (pr.body) {
        bodyLines.push('');
        bodyLines.push('## Description');
        bodyLines.push(pr.body);
      }
      const body = bodyLines.join('\n');

      await octokit.repos.createRelease({
        owner,
        repo,
        tag_name: nextTag,
        name: nextTag,
        body,
        draft: false,
        prerelease: false,
        target_commitish: commitSha
      });

      console.log(`Created and published release ${nextTag} for PR #${pr.number}`);
    }
  } catch (err) {
    console.error('Error publishing release:', err);
    process.exit(1);
  }
})();