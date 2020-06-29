const { inspect } = require("util");
const core = require("@actions/core");
const github = require("@actions/github");
const {
  getInputs,
  getCommandsConfig,
  configIsValid,
  actorHasPermission,
  getActorPermission,
  addReaction,
  getSlashCommandPayload
} = require("./func");

async function run() {
  try {
    // Only handle 'created' and 'edited' event types
    if (!["created", "edited"].includes(github.context.payload.action)) {
      core.warning(
        `Event type '${github.context.payload.action}' not supported.`
      );
      return;
    }

    // Get action inputs
    const inputs = getInputs();
    core.debug(`Inputs: ${inspect(inputs)}`);

    // Check required inputs
    if (!inputs.token) {
      core.setFailed("Missing required input 'token'.");
      return false;
    }

    // Get configuration for registered commands
    const config = getCommandsConfig(inputs);
    core.debug(`Commands config: ${inspect(config)}`);

    // Check the config is valid
    if (!configIsValid(config)) return;

    // Get the comment body and id
    const commentBody = github.context.payload["comment"]["body"];
    const commentId = github.context.payload["comment"]["id"];
    core.debug(`Comment body: ${commentBody}`);
    core.debug(`Comment id: ${commentId}`);

    // Check if the first line of the comment is a slash command
    const firstLine = commentBody.split(/\r?\n/)[0].trim();
    if (firstLine.length < 2 || firstLine.charAt(0) != "/") {
      console.debug("The first line of the comment is not a valid slash command.");
      return;
    }

    // Split the first line into "words"
    const commandWords = firstLine.slice(1).split(" ");
    core.debug(`Command words: ${inspect(commandWords)}`);

    // Check if the command is registered for dispatch
    var configMatches = config.filter(function(cmd) {
      return cmd.command == commandWords[0];
    });
    core.debug(`Config matches on 'command': ${inspect(configMatches)}`);
    if (configMatches.length == 0) {
      core.info(`Command '${commandWords[0]}' is not registered for dispatch.`);
      return;
    }

    // Filter matching commands by issue type
    const isPullRequest = "pull_request" in github.context.payload.issue;
    configMatches = configMatches.filter(function(cmd) {
      return (
        cmd.issue_type == "both" ||
        (cmd.issue_type == "issue" && !isPullRequest) ||
        (cmd.issue_type == "pull-request" && isPullRequest)
      );
    });
    core.debug(`Config matches on 'issue_type': ${inspect(configMatches)}`);
    if (configMatches.length == 0) {
      const issueType = isPullRequest ? "pull request" : "issue";
      core.info(
        `Command '${commandWords[0]}' is not configured for the issue type '${issueType}'.`
      );
      return;
    }

    // Filter matching commands by whether or not to allow edits
    if (github.context.payload.action == "edited") {
      configMatches = configMatches.filter(function(cmd) {
        return cmd.allow_edits;
      });
      core.debug(`Config matches on 'allow_edits': ${inspect(configMatches)}`);
      if (configMatches.length == 0) {
        core.info(
          `Command '${commandWords[0]}' is not configured to allow edits.`
        );
        return;
      }
    }

    // Set octokit clients
    const octokit = new github.GitHub(inputs.token);
    const reactionOctokit = new github.GitHub(inputs.reactionToken)

    // At this point we know the command is registered
    // Add the "eyes" reaction to the comment
    // if (inputs.reactions)
    //   await addReaction(
    //     reactionOctokit,
    //     github.context.repo,
    //     commentId,
    //     "eyes"
    //   );

    // Get the actor permission
    const actorPermission = await getActorPermission(
      octokit,
      github.context.repo,
      github.context.actor
    );
    core.debug(`Actor permission: ${actorPermission}`);

    // Filter matching commands by the user's permission level
    configMatches = configMatches.filter(function(cmd) {
      return actorHasPermission(actorPermission, cmd.permission);
    });
    core.debug(`Config matches on 'permission': ${inspect(configMatches)}`);
    if (configMatches.length == 0) {
      core.info(
        `Command '${commandWords[0]}' is not configured for the user's permission level '${actorPermission}'.`
      );
      return;
    }

    // Determined that the command should be dispatched
    core.info(`Command '${commandWords[0]}' to be dispatched.`);

    // Define payload
    var clientPayload = {
      args: {},
      github: github.context
    };

    // Get the pull request context for the dispatch payload
    if (isPullRequest) {
      const { data: pullRequest } = await octokit.pulls.get({
        ...github.context.repo,
        pull_number: github.context.payload.issue.number
      });
      clientPayload["pull_request"] = pullRequest;
    }

    // Dispatch for each matching configuration
    for (const cmd of configMatches) {
      // Generate slash command payload
      clientPayload.args = getSlashCommandPayload(
        commandWords,
        cmd
      );
      core.debug(
        `Args payload: ${inspect(clientPayload.args)}`
      );
      // Dispatch the command
      const dispatchRepo = cmd.repository.split("/");
      const eventType = cmd.command + cmd.event_type_suffix;
      await octokit.repos.createDispatchEvent({
        owner: dispatchRepo[0],
        repo: dispatchRepo[1],
        event_type: eventType,
        client_payload: clientPayload
      });
      core.info(
        `Command '${cmd.command}' dispatched to '${cmd.repository}' ` +
          `with event type '${eventType}'.`
      );
    }

    // Add the "rocket" reaction to the comment
    if (inputs.reactions)
      await addReaction(
        reactionOctokit,
        github.context.repo,
        commentId,
        "rocket"
      );
  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();
