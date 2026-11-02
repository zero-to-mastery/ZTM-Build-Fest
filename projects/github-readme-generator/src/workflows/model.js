import {
  workflowPath,
  outputPath,
  validCron,
  safeField,
  actionRef,
  secretName,
  workflowHealth,
} from "./validate.js";
import { yaml } from "./serialize.js";
import { picture } from "../markdown/serialize.js";
export const providers = [
  {
    id: "constellation",
    name: "GitHub Constellation",
    project: "https://github.com/mnichols08/constellation",
    ref: "mnichols08/constellation@v3.0.0",
    notes:
      "Generates a constellation SVG; optional publishing preserves other output-branch files.",
  },
  {
    id: "snake",
    name: "Contribution Snake",
    project: "https://github.com/Platane/snk",
    ref: "Platane/snk/svg-only@v3",
    notes:
      "Generates light/dark SVGs. Optional output-branch publishing uses peaceiris/actions-gh-pages@v4 with keep_files enabled.",
  },
  {
    id: "metrics",
    name: "Metrics",
    project: "https://github.com/lowlighter/metrics",
    ref: "lowlighter/metrics@v3.34",
    notes:
      "Basic scaffold only. Configure a METRICS_TOKEN secret on GitHub; use the upstream configurator for advanced plugins.",
  },
  {
    id: "generic",
    name: "Scheduled command or action",
    project: "https://docs.github.com/en/actions",
    ref: "",
    notes:
      "Runs your reviewed repository command or an explicitly versioned action on GitHub, never in Studio.",
  },
  {
    id: "asset-refresh",
    name: "Repository asset refresh script",
    project: "https://docs.github.com/en/actions",
    ref: "",
    notes:
      "Requires your own scripts/refresh-readme-assets.mjs in the target repository. Studio does not install a runtime or regenerate assets in the background.",
  },
];
export function generateWorkflow(raw = {}) {
  if (raw.provider && !providers.some((p) => p.id === raw.provider))
    throw new Error("Unknown workflow helper.");
  const provider = providers.find((p) => p.id === raw.provider) || providers[0];
  const name = safeField(raw.name || `${provider.name} refresh`, 100).trim();
  if (!name) throw new Error("Enter a workflow name.");
  const filename = raw.filename || `${provider.id}.yml`,
    path = workflowPath(`.github/workflows/${filename}`);
  const username = safeField(raw.username || "", 39);
  if (username && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(username))
    throw new Error("Enter a GitHub username.");
  const user = username || "${{ github.repository_owner }}";
  const repository = safeField(raw.repository || "OWNER/REPOSITORY", 150);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.includes("..")
  )
    throw new Error("Enter owner/repository for the embed.");
  const output = outputPath(raw.output || `${provider.id}.svg`);
  if (!output.endsWith(".svg"))
    throw new Error("Choose an SVG output filename.");
  const branch = safeField(raw.outputBranch || "output", 100);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_/-]*$/.test(branch) ||
    branch.includes("//") ||
    branch.endsWith("/")
  )
    throw new Error("Choose a safe output branch.");
  const publish = raw.publish === true;
  const on = { workflow_dispatch: {} };
  const schedule = raw.schedule || "manual",
    cron =
      schedule === "daily"
        ? "17 3 * * *"
        : schedule === "weekly"
          ? "17 3 * * 1"
          : raw.cron;
  if (schedule !== "manual") {
    if (!validCron(cron))
      throw new Error("Enter a valid five-field cron schedule.");
    on.schedule = [{ cron }];
  }
  const steps = [
    {
      name: "Check out repository",
      uses: "actions/checkout@v4",
      with: {
        "persist-credentials": publish && provider.id === "constellation",
      },
    },
  ];
  const token = "${{ secrets.GITHUB_TOKEN }}",
    outputs = [],
    attribution = [
      {
        project: provider.project,
        ref: provider.ref || "User-configured command",
      },
    ];
  let embed = "",
    needsWrite = false;
  const image = (file) =>
    `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}/${file.split("/").map(encodeURIComponent).join("/")}`;
  if (provider.id === "constellation") {
    const withValues = {
      username: user,
      output,
      publish: String(publish),
      "output-branch": branch,
      token,
    };
    if (raw.configPath) withValues.config = outputPath(raw.configPath);
    if (raw.configJson) {
      if (raw.configPath)
        throw new Error("Choose config path or inline JSON, not both.");
      const json = safeField(raw.configJson, 20000);
      let config;
      try {
        config = JSON.parse(json);
      } catch {
        throw new Error("Constellation config must be valid JSON.");
      }
      if (!config || typeof config !== "object" || Array.isArray(config))
        throw new Error("Constellation config must be a JSON object.");
      if (/"(?:token|secret|password|authorization)"\s*:/i.test(json))
        throw new Error(
          "Do not include credentials in Constellation configuration.",
        );
      withValues["config-json"] = JSON.stringify(config);
    }
    steps.push({
      name: "Generate constellation",
      uses: provider.ref,
      with: withValues,
    });
    outputs.push(output);
    needsWrite = publish;
    if (publish)
      embed = `[![GitHub constellation](${image(output.split("/").at(-1))})](${provider.project})\n\nMade with [GitHub Constellation](${provider.project}).`;
  } else if (provider.id === "snake") {
    const light = output.split("/").at(-1),
      dark = light.replace(/\.svg$/, "-dark.svg");
    steps.push({
      name: "Generate contribution snake",
      uses: provider.ref,
      with: {
        github_user_name: user,
        outputs: `dist/${light}\ndist/${dark}?palette=github-dark`,
      },
    });
    outputs.push(`dist/${light}`, `dist/${dark}`);
    if (publish) {
      steps.push({
        name: "Publish generated images",
        uses: "peaceiris/actions-gh-pages@v4",
        with: {
          github_token: token,
          publish_branch: branch,
          publish_dir: "dist",
          keep_files: true,
        },
      });
      attribution.push({
        project: "https://github.com/peaceiris/actions-gh-pages",
        ref: "peaceiris/actions-gh-pages@v4",
      });
      needsWrite = true;
      embed = picture({
        light: image(light),
        dark: image(dark),
        alt: "GitHub contribution snake",
      });
    }
  } else if (provider.id === "metrics") {
    const secret = secretName(raw.secretName || "METRICS_TOKEN");
    steps.push({
      name: "Generate metrics",
      uses: provider.ref,
      with: {
        token: `${"${{"} secrets.${secret} }}`,
        user,
        filename: output,
        committer_token: token,
        output_action: publish ? "commit" : "none",
        base: "header, activity, community, repositories, metadata",
      },
    });
    outputs.push(output);
    needsWrite = publish;
    if (publish) embed = `![GitHub metrics](./${output})`;
  } else {
    const command = safeField(
      raw.command ||
        (provider.id === "asset-refresh"
          ? "node scripts/refresh-readme-assets.mjs"
          : 'echo "Configure your repository command"'),
      4000,
    );
    if (
      /(?:token|secret|password|authorization)\s*[:=]\s*[^\s$]/i.test(command)
    )
      throw new Error(
        "Use GitHub secret references through a reviewed workflow; do not enter secret values in commands.",
      );
    if (raw.action) {
      steps.push({
        name: "Run configured action",
        uses: actionRef(raw.action),
      });
      attribution.push({
        project: `https://github.com/${raw.action.split("@")[0].split("/").slice(0, 2).join("/")}`,
        ref: raw.action,
      });
    } else steps.push({ name: "Run repository command", run: command });
  }
  const model = {
    name,
    on,
    permissions: { contents: needsWrite ? "write" : "read" },
    jobs: {
      generate: { "runs-on": "ubuntu-latest", "timeout-minutes": 15, steps },
    },
  };
  const warnings = workflowHealth({ ...model, outputs });
  if (provider.id === "asset-refresh")
    warnings.push(
      "Create and review the referenced repository script first; this scaffold does not upload its outputs.",
    );
  if (!publish && ["snake", "constellation", "metrics"].includes(provider.id))
    warnings.push(
      "Generated outputs are not committed. Enable publishing or add an artifact upload step manually.",
    );
  if (repository === "OWNER/REPOSITORY")
    warnings.push("Replace the example repository before inserting an embed.");
  return {
    config: structuredClone(raw),
    model,
    yaml: yaml(model) + "\n",
    path,
    outputs,
    embed,
    attribution,
    warnings,
    permissionReason: needsWrite
      ? "Contents write is required to commit generated SVG files."
      : "Contents read is sufficient for checkout; this scaffold does not publish files.",
  };
}
