const axios = require('axios');
const core = require('@actions/core');
const fs = require('fs');
const axiosRetry = require('axios-retry');
const YAML = require('yaml')
const github = require('@actions/github');

axiosRetry(axios, {
  retryDelay: (retryCount) => retryCount * 1000,
  retries: 3,
  shouldResetTimeout: true,
  onRetry: (retryCount, error, requestConfig) => {
    console.error("Error in request. Retrying...")
  }
});

const run_status = {
  1: 'Queued',
  2: 'Starting',
  3: 'Running',
  10: 'Success',
  20: 'Error',
  30: 'Cancelled'
}

const dbt_cloud_api = axios.create({
  baseURL: 'https://cloud.getdbt.com/api/v2/',
  timeout: 5000, // 5 seconds
  headers: {
    'Authorization': `Token ${core.getInput('dbt_cloud_token')}`,
    'Content-Type': 'application/json'
  }
});

const account_id = core.getInput('dbt_cloud_account_id');
const job_id = core.getInput('dbt_cloud_job_id');
const failure_on_error = core.getBooleanInput('failure_on_error');
const request_limit = core.getInput('dbt_cloud_request_limit');
const github_pr_number = github.context.issue.number;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const OPTIONAL_KEYS = [
  'git_sha',
  'git_branch',
  'schema_override',
  'dbt_version_override',
  'threads_override',
  'target_name_override',
  'generate_docs_override',
  'timeout_seconds_override',
  'steps_override',
];

const BOOL_OPTIONAL_KEYS = ['generate_docs_override'];
const INTEGER_OPTIONAL_KEYS = ['threads_override', 'timeout_seconds_override'];
const YAML_PARSE_OPTIONAL_KEYS = ['steps_override'];

async function runJob() {
  const cause = core.getInput('cause');

  const body = { cause };

  for (const key of OPTIONAL_KEYS) {
    let input = core.getInput(key);

    if (input != '' && BOOL_OPTIONAL_KEYS.includes(key)) {
      input = core.getBooleanInput(key);
    } else if (input != '' && INTEGER_OPTIONAL_KEYS.includes(key)) {
      input = parseInt(input);
    } else if (input != '' && YAML_PARSE_OPTIONAL_KEYS.includes(key)) {
      core.debug(input);
      try {
        input = YAML.parse(input);
        if (typeof input == 'string') {
          input = [input];
        }
      } catch (e) {
        core.setFailed(`Could not interpret ${key} correctly. Pass valid YAML in a string.\n Example:\n  property: '["a string", "another string"]'`);
        throw e;
      }
    }

    // Type-checking equality becuase of boolean inputs
    if (input !== '') {
      body[key] = input;
    }
  }

  core.debug(`Run job body:\n${JSON.stringify(body, null, 2)}`)

  let res = await dbt_cloud_api.post(`/accounts/${account_id}/jobs/${job_id}/run/`, body)
  return res.data;
}

const filterTriggeredRuns = (jobRuns) => {
  const foundRun = jobRuns.find(run => {
    if (run.trigger.github_pull_request_id !== undefined) {
      return run.trigger.github_pull_request_id === github_pr_number
    }
  });

  return foundRun;
}

const getTriggeredJobRuns = async (offset) => {
  const url =
    `accounts/${account_id}/runs/` +
    `?job_definition_id=${job_id}` +
    '&include_related=trigger' +
    '&order_by=-created_at' +
    `&offset=${offset}` +
    `&limit=${request_limit}`;

  const response = await dbt_cloud_api.get(url);
  return response.data;
}

const getTriggeredRunId = async () => {
  let hasMoreRecords = true;
  let offset = 0;
  let runObj = undefined;

  while (hasMoreRecords) {
    const jobRuns = await getTriggeredJobRuns(offset);

    offset += jobRuns.extra.pagination.count;
    if (offset === jobRuns.extra.pagination.total_count) {
      hasMoreRecords = false
    };

    runObj = filterTriggeredRuns(jobRuns.data);
    if (runObj !== undefined) return runObj.id;
  }
  core.setFailed(`Unable to find a dbt Cloud run associated with Pull Request #${github_pr_number}`);
}


async function getJobRun(run_id) {
  try {
    let res = await dbt_cloud_api.get(`/accounts/${account_id}/runs/${run_id}/?include_related=["run_steps"]`);
    return res.data;
  } catch (e) {
    let errorMsg = e.toString()
    if (errorMsg.search("timeout of ") != -1 && errorMsg.search(" exceeded") != -1) {
      // Special case for axios timeout
      errorMsg += ". The dbt Cloud API is taking too long to respond."
    }

    console.error("Error getting job information from dbt Cloud. " + errorMsg);
  }
}

async function getArtifacts(run_id) {
  const dir = './target';

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }

  // TODO: parameterize
  artifact_names = ["run_results.json", "manifest.json"]

  for (let artifact_name of artifact_names) {
    let res = await dbt_cloud_api.get(`/accounts/${account_id}/runs/${run_id}/artifacts/${artifact_name}`);
    let run_results = res.data;
    core.info(`Saving ${artifact_name} in target directory`)
    fs.writeFileSync(`${dir}/${artifact_name}`, JSON.stringify(run_results));
  }
}


async function executeAction() {

  //const jobRun = await runJob();
  //const runId = jobRun.data.id;
  //core.info(`Triggered job. ${jobRun.data.href}`);
  const runId = await getTriggeredRunId();

  let res;
  while (true) {
    await sleep(core.getInput('interval') * 1000);
    res = await getJobRun(runId);

    if (!res) {
      // Retry if there is no response
      continue;
    }

    let status = run_status[res.data.status];
    core.info(`Run: ${res.data.id} - ${status}`);

    if (core.getBooleanInput('wait_for_job')) {
      if (res.data.is_complete) {
        core.info(`job finished with '${status}'`);
        break;
      }
    } else {
      core.info("Not waiting for job to finish. Relevant run logs will be omitted.")
      break;
    }
  }

  if (res.data.is_error && failure_on_error) {
    core.setFailed();
  }

  if (res.data.is_error) {
    // Wait for the step information to load in run
    core.info("Loading logs...")
    await sleep(5000);
    res = await getJobRun(runId);
    // Print logs
    for (let step of res.data.run_steps) {
      core.info("# " + step.name)
      core.info(step.logs)
      core.info("\n************\n")
    }
  }

  if (core.getBooleanInput('get_artifacts')) {
    await getArtifacts(runId);
  }

  const outputs = {
    "git_sha": res.data['git_sha'],
    "run_id": runId
  };

  return outputs;
}

async function main() {
  try {
    const outputs = await executeAction();
    const git_sha = outputs["git_sha"];
    const run_id = outputs["run_id"];

    // GitHub Action output
    core.info(`dbt Cloud Job commit SHA is ${git_sha}`)
    core.setOutput('git_sha', git_sha);
    core.setOutput('run_id', run_id);
  } catch (e) {
    // Always fail in this case because it is not a dbt error
    core.setFailed('There has been a problem with running your dbt cloud job:\n' + e.toString());
    core.debug(e.stack)
  }
}

main();
