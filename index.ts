import * as fs from 'fs/promises'
import * as github from '@actions/github'
import * as core from '@actions/core'
import { GetResponseDataTypeFromEndpointMethod } from '@octokit/types';

interface ReportSummary {
  statementRate: number
  statementsTotal: number
}

interface ReportClass {
  name: string
  filename: string
  statementsTotal: number
  statementsInvoked: number
}

interface ReportBucket {
  summary: ReportSummary
  classes: ReportClass[]
}

interface Report {
  all: ReportBucket
  changed: ReportBucket
}

async function run() {
  const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN || ''
  const repository = github.context.repo || {
    owner: process.env.GITHUB_REPOSITORY?.split("/", 2)[0] || '',
    repo: process.env.GITHUB_REPOSITORY?.split("/", 2)[1] || ''
  }
  const baseRef = core.getInput('base-ref') || process.env.GITHUB_BASE_REF || ''
  const headRef = core.getInput('head-ref') || process.env.GITHUB_HEAD_REF || ''
  const pullRequestNumber = Number.parseInt(core.getInput('pull-request-number') || process.env.GITHUB_PULL_REQUEST_NUMBER || '', 10) || github.context.payload.pull_request?.number
  const reportPath = core.getInput('report-path') || process.env.SCOVERAGE_REPORT_PATH || 'target/scala-2.13/scoverage-report/scoverage.xml'
  const octokit = github.getOctokit(githubToken)

  process.stderr.write(`Repository ${repository.owner}/${repository.repo}\n`)
  process.stderr.write(`Pull request #${pullRequestNumber}\n`)
  process.stderr.write(`Base ref ${baseRef}\n`)
  process.stderr.write(`Head ref ${headRef}\n`)

  const compareResponse = await octokit.rest.repos.compareCommits({
    ...repository,
    base: baseRef,
    head: headRef,
  })
  const changedFiles = compareResponse.data.files?.map(file => file.filename) || []
  process.stderr.write(`Changed files:\n`)
  changedFiles.forEach(changedFile => {
    process.stderr.write(`- ${changedFile}\n`)
  })

  const report = await parseReport(reportPath, changedFiles)
  const commentMarkdown = renderCommentMarkdown(report)
  if (pullRequestNumber) {
    await createOrUpdateIssueComment(octokit, repository, pullRequestNumber, commentMarkdown)
  } else {
    process.stdout.write(commentMarkdown)
  }
}

async function parseReport(reportPath: string, changedFiles: string[]): Promise<Report> {
  const xml = await fs.readFile(reportPath, 'utf8')

  const summaryRegex = /statement-count="(\d+)" statements-invoked="([^"]+)" statement-rate="([^"]+)" branch-rate="([^"]+)" version="1.0"/
  const summaryMatch = xml.match(summaryRegex)
  if (!summaryMatch) {
    throw new Error('unable to parse scoverage summary')
  }
  const [, statementCountStr, , statementRateStr, ] = summaryMatch
  const classRegex = /name="([^"]+)" filename="([^"]+)" statement-count="([^"]+)" statements-invoked="([^"]+)"/g
  const classMatches = Array.from(xml.matchAll(classRegex))

  const allClasses: ReportClass[] = classMatches
    .map<ReportClass>(classMatch => {
      const [, name, filename, statementCountStr, statementsInvokedStr] = classMatch
      const statementsTotal = Number.parseInt(statementCountStr, 10)
      const statementsInvoked = Number.parseInt(statementsInvokedStr, 10)
      return {
        name,
        filename,
        statementsTotal,
        statementsInvoked,
      }
    })
    const allSummary: ReportSummary = {
      statementRate: Number.parseFloat(statementRateStr),
      statementsTotal: Number.parseInt(statementCountStr, 10),
    }
    const all: ReportBucket = {
      summary: allSummary,
      classes: allClasses,
    }

  const changedClasses: ReportClass[] = allClasses.filter(classMatch => changedFiles.find(file => file.includes(classMatch.filename)))
  const changedSummary: ReportSummary = {
    statementRate: changedClasses.reduce((acc, classResult) => acc + classResult.statementsInvoked, 0) / changedClasses.reduce((acc, classResult) => acc + classResult.statementsTotal, 0) * 100,
    statementsTotal: changedClasses.reduce((acc, classResult) => acc + classResult.statementsTotal, 0),
  }
  const changed: ReportBucket = {
    summary: changedSummary,
    classes: changedClasses,
  }

  return {
    all,
    changed,
  }
}

function renderCommentMarkdown(report: Report): string {
  let result = ''
  const renderBucket = (title: string, bucket: ReportBucket) => {
    const summaryStatementCoverageRate = bucket.summary.statementRate / 100
    const summaryStatementCoverage = `${(summaryStatementCoverageRate * 100).toFixed(1)}% (${Math.round(bucket.summary.statementRate / 100 * bucket.summary.statementsTotal)}/${bucket.summary.statementsTotal})`
    const summaryStatementCoverageIcon = coverageRateIcon(summaryStatementCoverageRate, [0.8, 0.6])

    result = result + `<details>\n`
    result = result + `<summary>${title} ${summaryStatementCoverageIcon} ${summaryStatementCoverage}</summary>\n`
    result = result + `\n`
    result = result + `| Class | Statement coverage |\n`
    result = result + `|---|---|\n`
    bucket.classes.forEach(classResult => {
      const classNameSegments = classResult.name.split('.').reverse()
      const classNameAbbreviated = classNameSegments.slice(1).reduce((acc, next) => {
        if (acc.endsWith('...')) {
          return acc
        } else if ((acc + '.' + next).length > 80 - 3) {
          return acc + '...'
        } else {
          return acc + '.' + next
        }
      }, classNameSegments[0])
      const statementCoverageRate = classResult.statementsInvoked / classResult.statementsTotal
      const statementCoverageText = `${(statementCoverageRate * 100).toFixed(1)}% (${classResult.statementsInvoked}/${classResult.statementsTotal})`
      const statementCoverageIcon = coverageRateIcon(statementCoverageRate, [0.8, 0.6])
      result = result + `| \`${classNameAbbreviated}\` | ${statementCoverageIcon} ${statementCoverageText} |\n`
    })
    result = result + `\n`
    result = result + '</details>\n'
  }

  if (Number.isFinite(report.all.summary.statementRate)) {
    renderBucket('All files', report.all)
  }
  if (Number.isFinite(report.changed.summary.statementRate)) {
    renderBucket('Changed files', report.changed)
  }
  return result
}

async function createOrUpdateIssueComment(octokit: ReturnType<typeof github.getOctokit>, repository: typeof github.context.repo, issueNumber: number, body: string): Promise<void> {
  const commentTag = `<!-- airfocusio/github-action-scoverage-pull-request-comment "" -->`

  let existingComment: GetResponseDataTypeFromEndpointMethod<typeof octokit.rest.issues.listComments>[0] | undefined;
  for await (const { data: comments } of octokit.paginate.iterator(octokit.rest.issues.listComments, {
    ...repository,
    issue_number: issueNumber,
  })) {
    const foundComment = comments.find((comment) => comment?.body?.includes(commentTag))
    if (foundComment) {
      existingComment = foundComment
      break
    }
  }

  if (existingComment) {
    await octokit.rest.issues.updateComment({
      ...repository,
      comment_id: existingComment.id,
      body: body + '\n\n' + commentTag,
    })
  } else {
    await octokit.rest.issues.createComment({
      ...repository,
      issue_number: issueNumber,
      body: body + '\n\n' + commentTag,
    })
  }
}

function coverageRateIcon(rate: number, thresholds: [number, number]): string {
  if (rate >= thresholds[0]) {
    return ':green_circle:'
  } else if (rate >= thresholds[1]) {
    return ':yellow_circle:'
  } else {
    return ':red_circle:'
  }
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
