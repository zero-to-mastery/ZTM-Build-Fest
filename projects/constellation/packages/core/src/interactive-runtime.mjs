import { mountTemporalStack } from "./temporal-stack-runtime.mjs";
import { createExplanationHelpers, EVIDENCE_VERSION, dimensionName, layoutSummary } from "./evidence.mjs";
// This function is also embedded verbatim into standalone HTML. Keep dependencies
// explicit in its arguments and use DOM text APIs for all scene-provided content.
const canonicalExplanations = createExplanationHelpers(EVIDENCE_VERSION, dimensionName, layoutSummary);
export function mountInteractive(root, source, options = {}, explanations = canonicalExplanations, fitViewport = null) {
  const scene = source.kind === "time-lapse" ? source.latest : source;
  const svg = root.querySelector("[data-canvas] > svg");
  if (!svg) throw new Error("Interactive view requires a rendered scene.");
  const abort = new AbortController();
  const listen = (target, type, handler, settings = {}) =>
    target.addEventListener(type, handler, {
      ...settings,
      signal: abort.signal,
    });
  const status = root.querySelector("[data-status]");
  const details = root.querySelector("[data-details]");
  const developerProfile = scene.developerProfile;
  const profileSelection = new Set();
  const base = [...scene.viewport.viewBox];
  const records = new Map(
    (scene.temporalStack
      ? (scene.temporalStack.frames || scene.timeline.frames).flatMap(
          (frame) => frame.scene.nodes,
        )
      : scene.nodes
    ).map((node) => [node.id, node]),
  );
  const groups = [...svg.querySelectorAll(".repository")].filter(
    (group) => group.style.display !== "none",
  );
  const allIds = [
    ...new Set(
      groups
        .map((group) => group.querySelector(".star")?.dataset.repo)
        .filter((id) => records.has(id)),
    ),
  ];
  let ids = [...allIds];
  const groupId = (group) => group.querySelector(".star")?.dataset.repo;
  let camera = [...base],
    selected = null,
    endpoint = null,
    path = [],
    dragging = null,
    moved = false;
  let semanticContext = null;
  // Evidence Navigation: an optional retained Rust index explains why projects
  // connect. Focus never changes geometry, config, or the underlying graph.
  const navigator = options.navigator || options.engine?.navigatorFor?.(scene) || null;
  let navigation = null,
    related = null;
  const focusMode = () =>
    !selected ? "overview" : endpoint ? "path" : related ? "relationship" : "project";
  const projectName = (id) =>
    records.get(id)?.metadata.name ||
    navigation?.connections.find((item) => item.projectId === id)?.label ||
    id;
  const make = (tag, text, attributes = {}) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };
  // Plain-language reasons; shared metadata is never presented as a dependency.
  function reasons(connection) {
    return connection.relationships.map((item) => {
      const labels = [...new Set(item.evidence.map((entry) => entry.label).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const more = item.evidenceCount > item.evidence.length ? ` (+${item.evidenceCount - item.evidence.length} more)` : "";
      const text = {
        "explicit-relationship": "Project relationship defined by the author",
        "authored-family": `Same project family, defined by the author: ${labels.join(", ")}`,
        "shared-language": `Shared primary language: ${labels.join(", ")}`,
        "shared-topic": `Shared repository topic${labels.length > 1 ? "s" : ""}: ${labels.join(", ")}`,
      }[item.type];
      const authored = item.evidence.some((entry) => entry.provenance.includes("user"));
      return { type: item.type, labels, text: text + more, origin: authored ? "author-defined" : "repository metadata" };
    });
  }
  const connectionSummary = (connection) =>
    reasons(connection)
      .map((item) => item.type === "explicit-relationship" ? "linked by author" : item.type === "authored-family" ? `family ${item.labels.join(", ")}` : item.type === "shared-topic" ? item.labels.map((label) => `#${label}`).join(" ") : item.labels.join(", "))
      .join(" · ");
  const focusDetail = (source) => ({
    mode: focusMode(),
    projectId: selected,
    relatedId: related,
    connections: navigation?.connections.map((item) => item.projectId) || [],
    source,
  });
  let occurrenceYear = null,
    occurrenceLayer = null;
  function frameForOccurrence(
    year = occurrenceYear,
    layerId = occurrenceLayer,
  ) {
    if (!scene.temporalStack) return null;
    const layer = scene.temporalStack.layers.find(
      (item) =>
        (year !== null && item.year === Number(year)) ||
        (layerId && item.id === layerId),
    );
    return (
      (layer &&
        (scene.temporalStack.frames || scene.timeline?.frames || []).find(
          (frame) => frame.id === layer.frameId,
        )) ||
      null
    );
  }
  function profileForElement(element) {
    const layer = element?.closest("[data-temporal-year], [data-layer-id]");
    const year = element?.dataset.year ?? layer?.dataset.temporalYear;
    const layerId = element?.dataset.layerId ?? layer?.dataset.layerId;
    return (
      frameForOccurrence(year ? Number(year) : null, layerId || null)?.scene
        .developerProfile || developerProfile
    );
  }
  const edges = [...svg.querySelectorAll(".shared-language")].filter(
    (edge) => ids.includes(edge.dataset.from) && ids.includes(edge.dataset.to),
  );
  let pairs = Uint32Array.from(
    edges.flatMap((edge) => [
      ids.indexOf(edge.dataset.from),
      ids.indexOf(edge.dataset.to),
    ]),
  );
  let filter = { query: "", language: "" },
    theme = "original";
  const announce = (text) => {
    if (status) status.textContent = text;
  };
  const emit = (type, detail) =>
    root.dispatchEvent(
      new CustomEvent(type, { detail, bubbles: true, composed: true }),
    );
  const applyCamera = () => {
    svg.setAttribute("viewBox", camera.join(" "));
    emit("camera-change", { viewBox: [...camera] });
  };
  function setCamera(value) {
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      !value.every(Number.isFinite) ||
      value[2] <= 0 ||
      value[3] <= 0
    )
      throw new Error("Invalid camera viewBox.");
    camera = [...value];
    applyCamera();
  }
  function zoom(factor, point) {
    const width = Math.max(
      base[2] / 20,
      Math.min(base[2] * 4, camera[2] * factor),
    );
    const ratio = width / camera[2],
      anchor = point || [camera[0] + camera[2] / 2, camera[1] + camera[3] / 2];
    camera = [
      anchor[0] - (anchor[0] - camera[0]) * ratio,
      anchor[1] - (anchor[1] - camera[1]) * ratio,
      width,
      camera[3] * ratio,
    ];
    applyCamera();
  }
  function screenPoint(x, y) {
    const point = svg.createSVGPoint();
    point.x = x;
    point.y = y;
    return point.matrixTransform(svg.getScreenCTM().inverse());
  }
  function focusNode(id) {
    const record = records.get(id);
    if (!record) return;
    const target = groups.find(
      (group) =>
        groupId(group) === id && group.getBoundingClientRect().width > 0,
    );
    const box = target?.getBoundingClientRect();
    const point = box
      ? screenPoint(box.x + box.width / 2, box.y + box.height / 2)
      : record.geometry;
    const width = Math.min(camera[2], base[2] / 3),
      height = (width * base[3]) / base[2];
    setCamera([point.x - width / 2, point.y - height / 2, width, height]);
  }
  function showRelationship(id) {
    const connection = navigation.connections.find((item) => item.projectId === related);
    const heading = make("h2", `${projectName(id)} ↔ ${projectName(related)}`, { tabindex: "-1", "data-focus-heading": "" });
    const list = make("ul", null, { class: "focus-reasons" });
    for (const reason of reasons(connection)) {
      const item = make("li", reason.text);
      item.append(make("span", ` · ${reason.origin}`, { class: "focus-origin" }));
      list.append(item);
    }
    const actions = make("div", null, { class: "focus-actions" });
    actions.append(make("button", `Back to ${projectName(id)}`, { type: "button", "data-focus-project": id }));
    if (ids.includes(related)) actions.append(make("button", `Focus ${projectName(related)}`, { type: "button", "data-focus-project": related }));
    actions.append(make("button", "Back to overview", { type: "button", "data-focus-overview": "" }));
    details.append(heading, make("p", "Why these projects are connected"), list,
      make("p", "Connections reflect shared repository metadata or links the author defined. They are not verified dependencies.", { class: "focus-note" }), actions);
  }
  function showConnections() {
    const section = make("section", null, { class: "focus-navigation", "aria-label": "Evidence-backed connections" });
    const count = navigation.connections.length;
    section.append(make("h3", count ? `Connections (${count}${navigation.truncated ? "+" : ""})` : "No evidence-backed connections"));
    const button = (connection) => make("li").appendChild(make("button", `${connection.label} — ${connectionSummary(connection)}`, { type: "button", "data-focus-relationship": connection.projectId })).parentNode;
    const list = make("ul", null, { class: "focus-connections" });
    list.append(...navigation.connections.slice(0, 12).map(button));
    section.append(list);
    if (count > 12) {
      const more = make("details");
      more.append(make("summary", `More connections (${count - 12})`), make("ul", null, { class: "focus-connections" }));
      more.lastChild.append(...navigation.connections.slice(12).map(button));
      section.append(more);
    }
    if (count) {
      const second = make("details", null, { "data-second-degree": "" });
      second.append(make("summary", "Two steps away"));
      second.addEventListener("toggle", () => {
        if (!second.open || second.childElementCount > 1) return;
        const result = navigator.navigate(selected, 2);
        const items = (result?.secondDegree || []).map((item) => {
          const text = `${item.label} — via ${projectName(item.path[1])}`;
          return ids.includes(item.projectId) ? make("li").appendChild(make("button", text, { type: "button", "data-focus-project": item.projectId })).parentNode : make("li", text);
        });
        const list = make("ul", null, { class: "focus-connections" });
        list.append(...items);
        second.append(items.length ? list : make("p", "No projects two steps away."));
      });
      section.append(second);
    }
    section.append(make("button", "Back to overview", { type: "button", "data-focus-overview": "" }));
    details.append(section);
  }
  function showDetails(id) {
    if (!details) return;
    details.replaceChildren();
    if (!id) return;
    if (related && navigation) return showRelationship(id);
    const frame = frameForOccurrence();
    const semantic = scene.semanticGroups;
    const group = semantic?.groups?.find(item => item.id === id) || (semanticContext?.group.id === id ? semanticContext.group : null);
    const record = frame?.scene.nodes.find((node) => node.id === id) || records.get(id);
    const metadata = record?.metadata || (group ? { name: group.label, description: `${group.members.length} projects · ${group.provenance === 'user' ? 'project family' : 'derived group'}` } : null);
    if (!metadata) return;
    const heading = document.createElement("h2");
    heading.textContent = metadata.name || id;
    const description = document.createElement("p");
    description.textContent = metadata.description || "";
    const summary = document.createElement("p");
    summary.textContent = [
      metadata.language,
      Number.isFinite(metadata.stargazers_count)
        ? `${metadata.stargazers_count} stars`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    details.append(heading, description, summary);
    const expandedGroup = semantic?.groups?.find(item => item.members.includes(id) && semantic.expanded.includes(item.id));
    if (group) {
      const groupExplanation = group.explanation || semanticContext?.explanation || null;
      const whyGrouped = document.createElement('details');
      const whySummary = document.createElement('summary'); whySummary.textContent = 'Why grouped?'; whyGrouped.append(whySummary);
      const reasonHeading = document.createElement('h3'); reasonHeading.textContent = 'Grouping reason';
      const provenance = document.createElement('p'); provenance.textContent = groupExplanation?.groupingReason?.summary || (group.provenance === 'user' ? 'Defined by you.' : 'Shared repository owner');
      whyGrouped.append(reasonHeading, provenance);
      if (groupExplanation?.memberSummary) { const memberSummary = document.createElement('p'); memberSummary.textContent = groupExplanation.memberSummary; whyGrouped.append(memberSummary); }
      if (group.kind === 'repository-owner') { const owner = document.createElement('p'); owner.textContent = `${group.label} · ${group.members.length} / ${group.members.length}`; whyGrouped.append(owner); }
      if (groupExplanation?.limitation) { const limitation = document.createElement('p'); limitation.textContent = groupExplanation.limitation; whyGrouped.append(limitation); }
      if (groupExplanation?.characteristics?.length) {
        const characteristicsHeading = document.createElement('h3'); characteristicsHeading.textContent = 'Common characteristics';
        whyGrouped.append(characteristicsHeading);
        for (const [kind, label] of [['language', 'Languages'], ['topic', 'Topics']]) {
          const entries = groupExplanation.characteristics.filter(entry => entry.kind === kind);
          if (!entries.length) continue;
          const kindHeading = document.createElement('h4'); kindHeading.textContent = label;
          const list = document.createElement('ul');
          for (const entry of entries) { const item = document.createElement('li'); item.textContent = `${entry.value} — ${entry.count} / ${entry.total}`; list.append(item); }
          whyGrouped.append(kindHeading, list);
        }
      }
      const members = document.createElement('ul');
      for (const member of (groupExplanation?.members || group.members.slice(0, 8).map(id => ({ id })))) { const item = document.createElement('li'); item.textContent = member.name || member.id.split('/').at(-1); members.append(item); }
      if (groupExplanation?.memberExamplesTruncated) { const item = document.createElement('li'); item.textContent = `+${groupExplanation.memberCount - groupExplanation.members.length} more`; members.append(item); }
      const memberHeading = document.createElement('h3'); memberHeading.textContent = 'Members'; whyGrouped.append(memberHeading, members); details.append(whyGrouped);
      if (options.semanticGroupActions !== false) {
        const expanded = semantic?.expanded?.includes(group.id) || semanticContext?.expanded === true;
        const action = document.createElement('button'); action.type = 'button';
        if (expanded) { action.dataset.semanticCollapse = group.id; action.textContent = 'Collapse group'; }
        else { action.dataset.semanticExpand = group.id; action.textContent = 'Expand group'; }
        details.append(action);
      }
    } else if (expandedGroup && options.semanticGroupActions !== false) {
      const collapse = document.createElement('button'); collapse.type = 'button'; collapse.dataset.semanticCollapse = expandedGroup.id; collapse.textContent = `Collapse ${expandedGroup.label}`; details.append(collapse);
    }
    // A retained semantic parent can be shown in the inspector while its
    // projects are visible, but it is not a node in that expanded scene.
    const explanation = record ? explanations.explainNode(frame?.scene || scene, id) : null;
    const why = document.createElement("details");
    const whySummary = document.createElement("summary");
    whySummary.textContent = "Why is this here?";
    why.append(whySummary);
    const addWhy = (label, text) => {
      const title = document.createElement("h3");
      title.textContent = label;
      const value = document.createElement("p");
      value.textContent = text;
      why.append(title, value);
    };
    if (explanation) {
      addWhy("Included", explanation.included.summary);
      addWhy("Position", explanation.position.summary);
      if (explanation.role) addWhy("Showcase role", explanation.role.summary);
      for (const [channel, detail] of Object.entries(explanation.appearance)) addWhy(channel[0].toUpperCase() + channel.slice(1), detail.summary);
    }
    const profileFacts = explanation?.position?.evidence || [];
    if (profileFacts.length) addWhy("Evidence", profileFacts.join(" · "));
    const sourceFacts = (explanation?.evidence || []).filter(item => item.provenance === "source" && ["primary-language", "topic"].includes(item.claim?.kind)).map(item => item.claim.value);
    if (sourceFacts.length) addWhy("Source evidence", [...new Set(sourceFacts)].join(" · "));
    if (endpoint) {
      const reasons = path.slice(1).flatMap((to, index) => {
        const from = path[index];
        const edge = edges.find(item => item.dataset.from === from && item.dataset.to === to || item.dataset.to === from && item.dataset.from === to);
        if (!edge) return [];
        const detail = explanations.explainEdge(scene, edge.id);
        return detail ? [detail] : [];
      });
      addWhy("Connection", reasons.length ? reasons.map(detail => `${detail.summary}${detail.universal?.length ? ` Shared across all: ${detail.universal.map(item => `${item.value} ${item.count} / ${item.total}`).join(" · ")}` : detail.evidence.length ? ` Shared across all: ${detail.evidence.join(" · ")}` : ""}${detail.partial?.length ? ` Common evidence: ${detail.partial.map(item => `${item.value} ${item.count} / ${item.total}`).join(" · ")}` : ""}${detail.examples?.length ? ` Examples: ${detail.examples.map(item => `${item.from} ↔ ${item.to}`).join(" · ")} (${detail.examplesShown} of ${detail.relationshipCount} shown)` : ""}${detail.truncated ? ` ${detail.retainedEdgeCount} of ${detail.relationshipCount} edge references retained.` : ""}`).join(" ") : "Explanation unavailable for this connection type.");
    }
    if (why.childNodes.length > 1) details.append(why);
    const projectShowcase = scene.presentation?.options?.projectShowcase || {};
    const lookup = (project) =>
      projectShowcase[project] ||
      Object.entries(projectShowcase).find(
        ([key]) => key.toLowerCase() === project.toLowerCase(),
      )?.[1];
    const showcase =
      lookup(id) || (metadata.full_name ? lookup(metadata.full_name) : null);
    if (showcase?.role) {
      const role = document.createElement("p");
      role.textContent = `Project role: ${showcase.role}${showcase.role === "featured" && Number.isInteger(showcase.priority) ? ` · Featured order ${showcase.priority}` : ""}`;
      details.append(role);
    }
    const evidenceRepositories = new Set(
      [id, ...(Array.isArray(metadata.members) ? metadata.members : [])].map(
        (value) => value.toLowerCase(),
      ),
    );
    const evidenceProfile = frame?.scene.developerProfile || developerProfile;
    const profileEvidence =
      evidenceProfile?.dimensions.flatMap((dimension) =>
        dimension.evidence
          .filter((item) =>
            evidenceRepositories.has(item.repository.toLowerCase()),
          )
          .map(
            (item) => `${dimension.id}: ${item.repository} (${item.reason})`,
          ),
      ) || [];
    if (profileEvidence.length) {
      const evidence = document.createElement("p");
      evidence.textContent = `Developer evidence: ${profileEvidence.join("; ")}.`;
      details.append(evidence);
    }
    if (Array.isArray(metadata.members)) {
      const featured = metadata.members
        .filter((member) => lookup(member)?.role === "featured")
        .map((member) =>
          lookup(member).priority
            ? `${member} (#${lookup(member).priority})`
            : member,
        );
      if (featured.length) {
        const projects = document.createElement("p");
        projects.textContent = `Featured projects using this node: ${featured.join(", ")}`;
        details.append(projects);
      }
    }
    if (scene.temporalStack) {
      const evidence = document.createElement("p");
      evidence.textContent = frame
        ? scene.temporalStack.axis === "year"
          ? `${occurrenceYear} · ${frame.evidence === "current-metadata" ? "Retrospective view using current metadata" : frame.evidence} · ${frame.date.slice(0, 10)}`
          : "Current repository membership in this universe layer."
        : "Latest available metadata for this project.";
      details.append(evidence);
    }
    if (record?.interaction?.childScene) {
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Explore this node";
      open.dataset.openChild = record.interaction.childScene;
      details.append(open);
    }
    if (typeof metadata.html_url === "string") {
      try {
        const url = new URL(metadata.html_url);
        if (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        ) {
          const link = document.createElement("a");
          link.href = url.href;
          link.textContent = "Open project";
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          details.append(link);
        }
      } catch {
        /* Non-URL source metadata stays plain text. */
      }
    }
    // Appended last so existing inspector structure and order are unchanged.
    if (navigation && id === selected && !endpoint) showConnections();
  }
  function highlight() {
    const engine = options.engine;
    const evidence = Boolean(selected && !endpoint && navigation);
    const indices =
      selected && engine && !evidence
        ? endpoint
          ? engine.shortest_path(
              ids.length,
              pairs,
              ids.indexOf(selected),
              ids.indexOf(endpoint),
            )
          : engine.neighbors(ids.length, pairs, ids.indexOf(selected))
        : [];
    path = endpoint ? Array.from(indices, (index) => ids[index]) : [];
    const highlighted = new Set(Array.from(indices, (index) => ids[index]));
    if (evidence)
      for (const connection of navigation.connections)
        if (!related || connection.projectId === related) highlighted.add(connection.projectId);
    if (selected) highlighted.add(selected);
    if (endpoint) highlighted.add(endpoint);
    const enabled =
      scene.layers.find((layer) => layer.id === "selection")?.visible !== false;
    svg.toggleAttribute(
      "data-interactive-selection",
      Boolean(selected && (engine || evidence) && enabled),
    );
    root.dataset.focus = focusMode();
    for (const group of groups) {
      group.toggleAttribute("data-related", highlighted.has(groupId(group)));
      group.setAttribute(
        "aria-pressed",
        String(groupId(group) === selected || groupId(group) === endpoint),
      );
    }
    for (const label of svg.querySelectorAll(".repo-label"))
      label.toggleAttribute("data-related", highlighted.has(label.dataset.repo));
    for (const edge of edges) {
      const { from, to } = edge.dataset;
      edge.toggleAttribute(
        "data-related",
        endpoint
          ? path.some(
              (id, i) =>
                i > 0 &&
                ((path[i - 1] === from && id === to) ||
                  (path[i - 1] === to && id === from)),
            )
          : (from === selected && highlighted.has(to)) ||
              (to === selected && highlighted.has(from)),
      );
    }
  }
  function selectNode(
    id,
    { focus = true, extend = false, year = null, layerId = null, source = "api" } = {},
  ) {
    if (!records.has(id) || !ids.includes(id))
      throw new Error(`Unknown or hidden node: ${id}`);
    occurrenceYear = year;
    occurrenceLayer = layerId;
    semanticContext = null;
    related = null;
    if (extend && selected) endpoint = id;
    else {
      selected = id;
      endpoint = null;
      navigation = navigator?.navigate(id, 1) || null;
      if (navigation?.status !== "ok") navigation = null;
    }
    svg.removeAttribute("data-exploring");
    highlight();
    showDetails(id);
    if (focus) focusNode(id);
    announce(
      endpoint
        ? path.length
          ? `${path.length - 1} connections: ${path.map((id) => records.get(id).metadata.name).join(" → ")}`
          : "No path between the selected nodes."
        : `${records.get(id).metadata.name}.${navigation ? ` ${navigation.connections.length} evidence-backed connection${navigation.connections.length === 1 ? "" : "s"}. Press Escape to return to the overview.` : ""} Shift-select another node to trace a path.`,
    );
    emit("node-select", {
      id,
      node: structuredClone(records.get(id)),
      start: selected,
      end: endpoint,
      path: [...path],
    });
    emit("focus-change", focusDetail(source));
  }
  function focusRelationship(projectId, relatedId, { source = "api" } = {}) {
    if (!records.has(projectId) || !ids.includes(projectId))
      throw new Error(`Unknown or hidden node: ${projectId}`);
    const result = selected === projectId && !endpoint && navigation ? navigation : navigator?.navigate(projectId, 1);
    const connection = result?.status === "ok" && result.connections.find((item) => item.projectId === relatedId);
    if (!connection) throw new Error(`No evidence-backed relationship: ${projectId} ↔ ${relatedId}`);
    const changed = selected !== projectId;
    selected = projectId;
    endpoint = null;
    navigation = result;
    related = relatedId;
    occurrenceYear = occurrenceLayer = semanticContext = null;
    svg.removeAttribute("data-exploring");
    highlight();
    showDetails(projectId);
    announce(`${projectName(projectId)} and ${projectName(relatedId)}: ${reasons(connection).map((item) => item.text).join("; ")}. Press Escape to return to ${projectName(projectId)}.`);
    if (changed) emit("node-select", { id: projectId, node: structuredClone(records.get(projectId)), start: selected, end: null, path: [] });
    emit("focus-change", focusDetail(source));
  }
  // Escape and the panel's back actions step out one level and move keyboard
  // focus to what represents the previous level, but only when focus was inside.
  function stepBack({ source = "user" } = {}) {
    if (!selected) return false;
    const active = root.getRootNode().activeElement, inside = Boolean(active && root.contains(active));
    if (related && !endpoint) {
      const previous = related;
      selectNode(selected, { focus: false, source });
      if (inside) [...(details?.querySelectorAll("[data-focus-relationship]") || [])].find((button) => button.dataset.focusRelationship === previous)?.focus();
      return true;
    }
    const previous = selected;
    clearSelection({ source });
    const node = groups.find((group) => groupId(group) === previous && group.getBoundingClientRect().width > 0);
    if (inside && node) {
      for (const group of groups) group.tabIndex = group === node ? 0 : -1;
      node.focus();
    }
    return true;
  }
  function focusHeading() {
    details?.querySelector("[data-focus-heading], h2")?.focus({ preventScroll: true });
  }
  function clearSelection({ source = "api" } = {}) {
    const had = Boolean(selected);
    selected = null;
    endpoint = null;
    navigation = null;
    related = null;
    occurrenceYear = null;
    occurrenceLayer = null;
    semanticContext = null;
    svg.removeAttribute("data-exploring");
    highlight();
    showDetails(null);
    announce(had && navigator ? "Returned to the overview." : "Selection cleared.");
    emit("node-select", { id: null, node: null });
    emit("focus-change", focusDetail(source));
  }
  function setProfileDimensions(values = []) {
    if (
      !developerProfile ||
      !Array.isArray(values) ||
      values.some(
        (value) =>
          !developerProfile.dimensions.some(
            (dimension) => dimension.id === value,
          ),
      )
    )
      throw new Error("Choose valid developer-profile dimensions.");
    profileSelection.clear();
    for (const value of values) profileSelection.add(value);
    const active = [...profileSelection];
    const relatedByProfile = new Map();
    const relatedFor = (profile) => {
      if (!profile) return new Set();
      if (!relatedByProfile.has(profile)) {
        const nodes = profile.nodes?.length
          ? profile.nodes
          : profile.repositories.map((repository) => ({
              node: repository.repository,
              dimensions: repository.dimensions,
            }));
        relatedByProfile.set(
          profile,
          new Set(
            nodes
              .filter((node) =>
                node.dimensions.some(
                  (score, index) =>
                    active.includes(profile.dimensions[index].id) && score > 0,
                ),
              )
              .map((node) => node.node),
          ),
        );
      }
      return relatedByProfile.get(profile);
    };
    svg.toggleAttribute("data-profile-selection", active.length > 0);
    if (active.length) svg.dataset.profileSelection = active.join(" ");
    else delete svg.dataset.profileSelection;
    for (const group of groups) {
      const id = groupId(group),
        contributes = relatedFor(profileForElement(group)).has(id);
      group.toggleAttribute("data-profile-related", contributes);
      group.setAttribute(
        "aria-label",
        `${records.get(id)?.metadata.name || id}${contributes ? `, evidence for ${active.join(" and ")}` : ""}. Select and focus.`,
      );
    }
    for (const label of svg.querySelectorAll(".repo-label"))
      label.toggleAttribute(
        "data-profile-related",
        relatedFor(profileForElement(label)).has(label.dataset.repo),
      );
    for (const edge of edges) {
      const related = relatedFor(profileForElement(edge));
      edge.toggleAttribute(
        "data-profile-related",
        related.has(edge.dataset.from) || related.has(edge.dataset.to),
      );
    }
    for (const button of root.querySelectorAll("[data-profile-dimension]"))
      button.setAttribute(
        "aria-pressed",
        String(profileSelection.has(button.dataset.profileDimension)),
      );
    const description = active.length
      ? developerProfile.dimensions
          .filter((dimension) => profileSelection.has(dimension.id))
          .map(
            (dimension) =>
              `${dimension.id}: ${
                dimension.evidence
                  .slice(0, 5)
                  .map((item) => `${item.repository} (${item.reason})`)
                  .join(", ") || "no selected repository evidence"
              }`,
          )
          .join(". ")
      : "";
    const profiles = scene.temporalStack
      ? (scene.temporalStack.frames || scene.timeline?.frames || [])
          .map((frame) => frame.scene.developerProfile)
          .filter(Boolean)
      : [developerProfile];
    const related = new Set(
      profiles.flatMap((profile) => [...relatedFor(profile)]),
    );
    announce(
      active.length
        ? `${related.size} repositories show evidence for ${active.join(" + ")}. ${description}`
        : "Developer dimensions cleared.",
    );
    emit("developer-dimension-change", {
      dimensions: active,
      repositories: [...related],
    });
  }
  function fit() {
    if (scene.temporalStack) return setCamera(base);
    if (fitViewport) {
      const fitted = fitViewport(scene, { nodeIds: ids }).viewport.viewBox;
      return setCamera(fitted || base);
    }
    const visible = scene.nodes.filter((node) => ids.includes(node.id));
    if (!visible.length) return setCamera(base);
    const left =
      Math.min(
        ...visible.map((node) => node.geometry.x - node.geometry.radius),
      ) - 30;
    const right =
      Math.max(
        ...visible.map((node) => node.geometry.x + node.geometry.radius),
      ) + 30;
    const top =
      Math.min(
        ...visible.map((node) => node.geometry.y - node.geometry.radius),
      ) - 30;
    const bottom =
      Math.max(
        ...visible.map((node) => node.geometry.y + node.geometry.radius),
      ) + 30;
    const width = Math.max(right - left, ((bottom - top) * base[2]) / base[3]),
      height = (width * base[3]) / base[2];
    setCamera([
      (left + right - width) / 2,
      (top + bottom - height) / 2,
      width,
      height,
    ]);
  }
  function reset() {
    clearSelection();
    setCamera(base);
  }
  function setFilter(value = {}) {
    if (
      (typeof value.query !== "undefined" && typeof value.query !== "string") ||
      (typeof value.language !== "undefined" &&
        typeof value.language !== "string")
    )
      throw new Error("Filter query and language must be text.");
    if ((value.query?.length || 0) > 512 || (value.language?.length || 0) > 512)
      throw new Error("Filter text exceeds 512 characters.");
    filter = { query: value.query || "", language: value.language || "" };
    const query = filter.query.trim().toLowerCase();
    ids = allIds.filter((id) => {
      const data = records.get(id).metadata;
      return (
        (!query ||
          `${id} ${data.name} ${data.description || ""}`
            .toLowerCase()
            .includes(query)) &&
        (!filter.language || data.language === filter.language)
      );
    });
    const visible = new Set(ids);
    for (const group of groups) {
      group.toggleAttribute("data-filtered", !visible.has(groupId(group)));
      group.setAttribute("tabindex", groupId(group) === ids[0] ? "0" : "-1");
    }
    for (const label of svg.querySelectorAll(".repo-label"))
      label.toggleAttribute("data-filtered", !visible.has(label.dataset.repo));
    for (const edge of edges)
      edge.toggleAttribute(
        "data-filtered",
        !visible.has(edge.dataset.from) || !visible.has(edge.dataset.to),
      );
    pairs = Uint32Array.from(
      edges
        .filter((edge) => !edge.hasAttribute("data-filtered"))
        .flatMap((edge) => [
          ids.indexOf(edge.dataset.from),
          ids.indexOf(edge.dataset.to),
        ]),
    );
    if (
      (selected && !visible.has(selected)) ||
      (endpoint && !visible.has(endpoint))
    )
      clearSelection();
    else highlight();
    const search = root.querySelector("[data-search]"),
      language = root.querySelector("[data-language]");
    if (search) search.value = filter.query;
    if (language) language.value = filter.language;
    announce(`${ids.length} of ${allIds.length} nodes visible.`);
    emit("filter-change", { ...filter, visible: ids.length });
  }
  function setTheme(value) {
    const palettes = {
      midnight: {
        background: "#111111",
        foreground: "#f3f3f4",
        accent: "#e3de13",
        line: "#555a38",
        star: "#e3de13",
      },
      light: {
        background: "#fafaf3",
        foreground: "#202516",
        accent: "#595600",
        line: "#838d66",
        star: "#8b8500",
      },
    };
    if (value !== "original" && !Object.hasOwn(palettes, value))
      throw new Error("Unknown interactive theme.");
    theme = value;
    for (const key of Object.keys(palettes.midnight)) {
      if (value === "original") svg.style.removeProperty(`--sky-${key}`);
      else svg.style.setProperty(`--sky-${key}`, palettes[value][key]);
    }
    svg.style.background =
      value === "original" ? "" : palettes[value].background;
    root.dataset.theme = value;
    const control = root.querySelector("[data-theme]");
    if (control) control.value = value;
    emit("theme-change", { theme });
  }
  const search = root.querySelector("[data-search]"),
    language = root.querySelector("[data-language]"),
    themeControl = root.querySelector("[data-theme]");
  if (search)
    listen(search, "input", () =>
      setFilter({ ...filter, query: search.value }),
    );
  if (language) {
    for (const name of [
      ...new Set(
        [...records.values()]
          .map((node) => node.metadata.language)
          .filter((value) => typeof value === "string" && value),
      ),
    ].sort()) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      language.append(option);
    }
    listen(language, "change", () =>
      setFilter({ ...filter, language: language.value }),
    );
  }
  if (themeControl)
    listen(themeControl, "change", () => setTheme(themeControl.value));
  if (developerProfile) {
    for (const segment of svg.querySelectorAll('.profile-segment')) {
      for (const type of ['focus', 'pointerenter', 'click', 'keydown']) listen(segment, type, event => {
        if (type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        if (type === 'keydown') event.preventDefault();
        setProfileDimensions([segment.dataset.profileDimension]);
      });
    }
    const toolbar = root.querySelector(".constellation-toolbar");
    if (toolbar) {
      const controls = document.createElement("div");
      controls.className = "developer-profile-controls";
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", "Developer evidence dimensions");
      for (const dimension of developerProfile.dimensions) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.profileDimension = dimension.id;
        button.textContent =
          dimension.id[0].toUpperCase() + dimension.id.slice(1);
        button.setAttribute("aria-pressed", "false");
        button.title = dimension.evidence
          .map((item) => `${item.repository}: ${item.reason}`)
          .join("\n");
        listen(button, "click", () => {
          const values = new Set(profileSelection);
          if (values.has(dimension.id)) values.delete(dimension.id);
          else values.add(dimension.id);
          setProfileDimensions([...values]);
        });
        controls.append(button);
      }
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "Clear dimensions";
      listen(clear, "click", () => setProfileDimensions([]));
      controls.append(clear);
      toolbar.append(controls);
    }
  }
  if (details)
    listen(details, "click", (event) => {
      const button = event.target.closest("[data-open-child]");
      if (button) emit("scene-open-request", { id: button.dataset.openChild });
      const expand = event.target.closest('[data-semantic-expand]');
      if (expand) emit('semantic-group-expand', { id: expand.dataset.semanticExpand });
      const collapse = event.target.closest('[data-semantic-collapse]');
      if (collapse) emit('semantic-group-collapse', { id: collapse.dataset.semanticCollapse });
      const relationship = event.target.closest("[data-focus-relationship]");
      if (relationship && selected) {
        focusRelationship(selected, relationship.dataset.focusRelationship, { source: "user" });
        focusHeading();
      }
      const project = event.target.closest("[data-focus-project]");
      if (project) {
        const previous = related, back = project.dataset.focusProject === selected;
        selectNode(project.dataset.focusProject, { focus: !back, source: "user" });
        const restore = back && [...details.querySelectorAll("[data-focus-relationship]")].find((button) => button.dataset.focusRelationship === previous);
        if (restore) restore.focus();
        else focusHeading();
      }
      if (event.target.closest("[data-focus-overview]")) {
        related = null;
        stepBack({ source: "user" });
      }
    });
  if (details) listen(details, 'keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const button = event.target.closest('[data-semantic-expand], [data-semantic-collapse]');
    if (!button) return;
    event.preventDefault(); button.click();
  });
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const updateMotion = () => {
    root.toggleAttribute("data-reduced-motion", motion.matches);
    if (motion.matches) {
      svg.pauseAnimations?.();
      svg.setCurrentTime?.(0);
    } else svg.unpauseAnimations?.();
  };
  listen(motion, "change", updateMotion);
  updateMotion();
  const resize =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          const { width, height } = entries[0].contentRect;
          emit("view-resize", { width, height });
        })
      : null;
  resize?.observe(root.querySelector("[data-canvas]"));
  svg.setAttribute("role", "group");
  svg.setAttribute("tabindex", "0");
  for (const group of groups) {
    const id = groupId(group),
      record = records.get(id);
    if (!record) continue;
    group.setAttribute("role", "button");
    group.setAttribute("tabindex", id === ids[0] ? "0" : "-1");
    group.setAttribute(
      "aria-label",
      `${record.metadata.name}${group.dataset.year ? `, ${group.dataset.year}` : ""}. Select and focus.`,
    );
    group.setAttribute("aria-pressed", "false");
    listen(group, "click", (event) => {
      if (!moved) {
        event.stopPropagation();
        selectNode(id, {
          extend: event.shiftKey,
          year: group.dataset.year ? Number(group.dataset.year) : null,
          layerId: group.dataset.layerId || null,
          source: "user",
        });
      }
    });
    listen(group, "pointerenter", () => {
      announce(record.metadata.name);
      emit("node-hover", { id });
    });
    listen(group, "pointerleave", () => emit("node-hover", { id: null }));
    listen(group, "keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectNode(id, {
          extend: event.shiftKey,
          year: group.dataset.year ? Number(group.dataset.year) : null,
          layerId: group.dataset.layerId || null,
          source: "user",
        });
      }
      if (event.key === "Escape" && selected) {
        event.preventDefault();
        stepBack();
      }
      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
        const navigation = scene.temporalStack
          ? [
              ...new Set(
                groups
                  .filter((node) => node.getBoundingClientRect().width > 0)
                  .map(groupId),
              ),
            ]
          : ids;
        const index = navigation.indexOf(id),
          next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? navigation.length - 1
                : (index +
                    (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) +
                    navigation.length) %
                  navigation.length;
        for (const node of groups)
          node.tabIndex = groupId(node) === navigation[next] ? 0 : -1;
        groups
          .find(
            (node) =>
              groupId(node) === navigation[next] &&
              node.getBoundingClientRect().width > 0,
          )
          ?.focus();
      }
    });
  }
  listen(
    svg,
    "wheel",
    (event) => {
      event.preventDefault();
      const point = screenPoint(event.clientX, event.clientY);
      zoom(Math.exp(Math.max(-500, Math.min(500, event.deltaY)) * 0.002), [
        point.x,
        point.y,
      ]);
    },
    { passive: false },
  );
  listen(svg, "pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("a")) return;
    moved = false;
    const matrix = svg.getScreenCTM();
    dragging = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      camera: [...camera],
      sx: matrix.a,
      sy: matrix.d,
    };
  });
  listen(svg, "pointermove", (event) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    const dx = event.clientX - dragging.x,
      dy = event.clientY - dragging.y;
    if (Math.hypot(dx, dy) > 4) {
      moved = true;
      svg.setPointerCapture(event.pointerId);
    }
    if (moved)
      setCamera([
        dragging.camera[0] - dx / dragging.sx,
        dragging.camera[1] - dy / dragging.sy,
        dragging.camera[2],
        dragging.camera[3],
      ]);
  });
  const endDrag = (event) => {
    if (dragging?.id === event.pointerId) {
      if (svg.hasPointerCapture(event.pointerId))
        svg.releasePointerCapture(event.pointerId);
      dragging = null;
    }
  };
  listen(svg, "pointerup", endDrag);
  listen(svg, "pointercancel", endDrag);
  for (const button of root.querySelectorAll("[data-action]"))
    listen(button, "click", () => {
      ({
        "zoom-in": () => zoom(0.8),
        "zoom-out": () => zoom(1.25),
        fit,
        reset,
        clear: () => clearSelection({ source: "user" }),
      })[button.dataset.action]?.();
    });
  listen(svg, "keydown", (event) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(0.8);
    }
    if (event.key === "-") {
      event.preventDefault();
      zoom(1.25);
    }
    if (event.key === "Escape" && !event.defaultPrevented && selected) {
      event.preventDefault();
      stepBack();
    }
  });
  listen(root, "keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !selected) return;
    event.preventDefault();
    stepBack();
  });
  // Pointer users can also open a relationship from a drawn connection.
  for (const edge of edges)
    listen(edge, "click", (event) => {
      if (moved || !navigator) return;
      const { from, to } = edge.dataset, start = selected === to ? to : from;
      try {
        focusRelationship(start, start === from ? to : from, { source: "user" });
        event.stopPropagation();
      } catch {
        /* No evidence-backed relationship for this drawn edge. */
      }
    });
  const api = {
    selectNode,
    clearSelection,
    focusProject: (id, { focus = false } = {}) => selectNode(id, { focus }),
    focusRelationship: (projectId, relatedId) => focusRelationship(projectId, relatedId),
    returnToOverview: () => clearSelection(),
    // Applies shared or history focus; unavailable projects fall back to the overview.
    restoreFocus({ project = null, related: other = null } = {}, { source = "history", invalid = false } = {}) {
      try {
        if (!project) {
          if (selected) clearSelection({ source });
          if (invalid) announce("The shared view could not be read. Showing the overview.");
          return !invalid;
        }
        if (other) focusRelationship(project, other, { source });
        else selectNode(project, { focus: false, source });
        return true;
      } catch {
        if (selected) clearSelection({ source });
        announce("The shared project is not available in this view. Showing the overview.");
        return false;
      }
    },
    get focusState() {
      return { mode: focusMode(), project: selected, related, connections: navigation?.connections.map((item) => item.projectId) || [] };
    },
    get navigation() {
      return navigation && structuredClone(navigation);
    },
    showSemanticContext(group, { expanded = false } = {}) {
      if (!group || typeof group.id !== 'string' || typeof group.label !== 'string' || !Array.isArray(group.members)) throw new Error('Invalid semantic context.');
      semanticContext = { group: structuredClone(group), expanded };
      showDetails(group.id);
    },
    announceSemanticLevel(level) {
      announce(level === 'projects' ? 'Project detail shown.' : level === 'overview' ? 'Grouped overview shown.' : 'Group detail shown.');
    },
    fit,
    reset,
    setCamera,
    setFilter,
    setTheme,
    setProfileDimensions,
    get filter() {
      return { ...filter };
    },
    get theme() {
      return theme;
    },
    get camera() {
      return [...camera];
    },
    get selection() {
      return selected;
    },
    get selectionState() {
      return { start: selected, end: endpoint, path: [...path] };
    },
    get profileSelection() {
      return [...profileSelection];
    },
    destroy() {
      abort.abort();
      resize?.disconnect();
      dragging = null;
      delete root.constellation;
    },
  };
  const temporalRuntime = mountTemporalStack(root, scene, api);
  const destroy = api.destroy;
  api.destroy = () => {
    temporalRuntime.destroy();
    destroy();
  };
  root.constellation = api;
  announce(
    "Select a node to focus. Drag to pan; use the zoom controls or mouse wheel.",
  );
  if (options.emitReady !== false) emit("scene-ready", { nodes: ids.length });
  return api;
}

export const interactiveStyles = `
.constellation-runtime{font:14px system-ui,sans-serif;color:#e9edf5;background:#11151e;border-radius:12px;overflow:hidden;max-width:1200px;margin:auto}
.constellation-toolbar{display:flex;gap:8px;flex-wrap:wrap;padding:12px;align-items:center}
.constellation-toolbar button{font:inherit;color:inherit;background:#283143;border:1px solid #52617c;border-radius:6px;padding:8px 12px;cursor:pointer}
.constellation-toolbar input,.constellation-toolbar select{font:inherit;max-width:180px;padding:6px;border-radius:4px}.constellation-toolbar label{display:flex;gap:6px;align-items:center}
.constellation-runtime [data-filtered]{display:none!important}
.constellation-toolbar button:focus-visible,.constellation-runtime .repository:focus-visible{outline:3px solid #a9cdfb;outline-offset:3px}
.developer-profile-controls{display:flex;gap:6px;flex-wrap:wrap;width:100%;padding-top:6px}.developer-profile-controls button[aria-pressed=true]{background:#385143;border-color:#a9d8b6}
.constellation-canvas{height:70vh;min-height:280px;overflow:hidden}
.constellation-canvas>svg{display:block;width:100%;height:100%;touch-action:none}
[data-viewports][data-comparing]{display:grid;grid-template-columns:1fr 1fr}[data-viewports]>[hidden]{display:none!important}
@media(max-width:600px){[data-viewports][data-comparing]{grid-template-columns:1fr}}
.constellation-runtime .repository{cursor:pointer}.constellation-runtime .repository[aria-pressed=true] .star-halo{opacity:.55}
.constellation-status{padding:8px 16px;min-height:1.5em;margin:0}
.constellation-details{padding:0 16px 16px}.constellation-details:empty{display:none}.constellation-details a{color:#a9cdfb}
[data-interactive-selection] .repository:not([data-related]),[data-interactive-selection] .repo-label:not([data-related]){opacity:.2}
[data-interactive-selection] .shared-language:not([data-related]){opacity:.07}
[data-profile-selection] .repository:not([data-profile-related]),[data-profile-selection] .repo-label:not([data-profile-related]){opacity:.17}
[data-profile-selection] .shared-language:not([data-profile-related]){opacity:.1}
.constellation-details button{font:inherit;color:inherit;background:#283143;border:1px solid #52617c;border-radius:6px;padding:8px 12px;min-height:44px;cursor:pointer;text-align:left}
.constellation-details button:focus-visible,.constellation-details summary:focus-visible,.constellation-details [data-focus-heading]:focus-visible{outline:3px solid #a9cdfb;outline-offset:2px}
.constellation-details summary{min-height:44px;display:list-item;cursor:pointer;padding:10px 0}.focus-connections{list-style:none;padding:0;margin:8px 0;display:grid;gap:6px}.focus-connections button{width:100%}
.focus-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.focus-note,.focus-origin{opacity:.8;font-size:13px}.focus-reasons{padding-left:20px}
.constellation-runtime .repository{pointer-events:bounding-box}.constellation-runtime .shared-language{cursor:pointer}[data-focus=relationship] .shared-language[data-related]{stroke-width:2.4}
@media(prefers-reduced-motion:no-preference){.constellation-runtime .repository,.constellation-runtime .repo-label,.constellation-runtime .shared-language{transition:opacity .2s}}
@media(prefers-reduced-motion:reduce){.constellation-runtime *{scroll-behavior:auto;transition:none!important;animation:none!important}}
`;
