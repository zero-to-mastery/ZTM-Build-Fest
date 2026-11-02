// Household reference records (Wi-Fi names, appliance models, contacts):
// their form with labelled fields, the list, and each record's
// maintenance log.
// Part of <kin-notes>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-notes.js lists them).
import { validateReferenceRecord } from "../../household-validation.js";

export class ReferenceSection {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  // The household reference records: their form, the list, and each
  // record's maintenance log. Returns the section.
  renderReferences(id) {
    const activeRecordIds = new Set(this.host.referenceRecords
      .filter((record) => !record.archived)
      .map((record) => record.recordId));
    for (const recordId of this.host.maintenanceDrafts.keys())
      if (!activeRecordIds.has(recordId)) this.host.maintenanceDrafts.delete(recordId);
    const references = document.createElement("section");
    references.className = "reference-records";
    const referenceHeading = document.createElement("h2");
    referenceHeading.textContent = "Household reference";
    const referenceHint = document.createElement("p");
    referenceHint.textContent = "Keep practical details such as Wi-Fi names, appliance models, or service contacts. Values are shared with the household.";
    const referenceForm = document.createElement("form");
    referenceForm.noValidate = true;
    const referenceEditor = this.host.referenceEditor ?? {
      recordId: null,
      title: "",
      areaId: "",
      fields: [{ fieldId: crypto.randomUUID().replaceAll("-", ""), label: "", value: "" }],
    };
    this.host.referenceEditor = referenceEditor;
    const referenceTitleId = id("reference-title");
    const referenceTitleLabel = document.createElement("label");
    referenceTitleLabel.htmlFor = referenceTitleId;
    referenceTitleLabel.textContent = "Title";
    const referenceTitle = document.createElement("input");
    referenceTitle.id = referenceTitleId;
    referenceTitle.value = referenceEditor.title;
    referenceTitle.dataset.focusId = "reference-title";
    const referenceTitleError = this.host.makeError(id("reference-title-error"));
    referenceTitle.setAttribute("aria-describedby", referenceTitleError.id);
    referenceTitle.addEventListener("input", () => { referenceEditor.title = referenceTitle.value; });

    const referenceAreaId = id("reference-area");
    const referenceAreaLabel = document.createElement("label");
    referenceAreaLabel.htmlFor = referenceAreaId;
    referenceAreaLabel.textContent = "Area (optional)";
    const referenceArea = document.createElement("select");
    referenceArea.id = referenceAreaId;
    const noReferenceArea = document.createElement("option");
    noReferenceArea.value = "";
    noReferenceArea.textContent = "No Area";
    referenceArea.append(noReferenceArea);
    for (const item of this.host.areaRecords.filter((candidate) => !candidate.archived)) {
      const option = document.createElement("option");
      option.value = item.areaId;
      option.textContent = item.name;
      referenceArea.append(option);
    }
    if (referenceEditor.areaId && ![...referenceArea.options].some((option) => option.value === referenceEditor.areaId)) {
      const oldArea = this.host.areaRecords.find((candidate) => candidate.areaId === referenceEditor.areaId);
      const option = document.createElement("option");
      option.value = referenceEditor.areaId;
      option.textContent = `${oldArea?.name ?? "Archived Area"} (archived)`;
      referenceArea.append(option);
    }
    referenceArea.value = referenceEditor.areaId;
    referenceArea.addEventListener("change", () => { referenceEditor.areaId = referenceArea.value; });

    const fieldHeading = document.createElement("h3");
    fieldHeading.textContent = "Fields";
    const referenceCountError = this.host.makeError(id("reference-count-error"));
    const referenceFields = document.createElement("div");
    referenceFields.className = "reference-field-list";
    const fieldControls = [];
    referenceEditor.fields.forEach((field, index) => {
      const fieldset = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = `Field ${index + 1}`;
      const labelId = id(`reference-label-${index}`);
      const fieldLabel = document.createElement("label");
      fieldLabel.htmlFor = labelId;
      fieldLabel.textContent = "Label";
      const labelInput = document.createElement("input");
      labelInput.id = labelId;
      labelInput.value = field.label;
      labelInput.dataset.focusId = `reference-label-${index}`;
      labelInput.dataset.referenceIndex = String(index);
      const labelError = this.host.makeError(id(`reference-label-error-${index}`));
      labelInput.setAttribute("aria-describedby", labelError.id);
      labelInput.addEventListener("input", () => { field.label = labelInput.value; });
      const valueId = id(`reference-value-${index}`);
      const valueLabel = document.createElement("label");
      valueLabel.htmlFor = valueId;
      valueLabel.textContent = "Value";
      const valueInput = document.createElement("textarea");
      valueInput.id = valueId;
      valueInput.rows = 2;
      valueInput.value = field.value;
      valueInput.dataset.focusId = `reference-value-${index}`;
      valueInput.dataset.referenceIndex = String(index);
      const valueError = this.host.makeError(id(`reference-value-error-${index}`));
      valueInput.setAttribute("aria-describedby", valueError.id);
      valueInput.addEventListener("input", () => { field.value = valueInput.value; });
      fieldset.append(fieldLabel, labelInput, labelError, valueLabel, valueInput, valueError);
      if (referenceEditor.fields.length > 1) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove field";
        remove.addEventListener("click", () => {
          referenceEditor.fields.splice(index, 1);
          this.host.pendingFocus = `reference-label-${Math.max(0, index - 1)}`;
          this.host.referenceEditor = referenceEditor;
          this.host.render();
        });
        fieldset.append(remove);
      }
      fieldControls.push({ labelInput, labelError, valueInput, valueError });
      referenceFields.append(fieldset);
    });
    const addReferenceField = document.createElement("button");
    addReferenceField.type = "button";
    addReferenceField.textContent = "Add field";
    addReferenceField.setAttribute("aria-describedby", referenceCountError.id);
    addReferenceField.addEventListener("click", () => {
      referenceEditor.fields.push({ fieldId: crypto.randomUUID().replaceAll("-", ""), label: "", value: "" });
      this.host.pendingFocus = `reference-label-${referenceEditor.fields.length - 1}`;
      this.host.referenceEditor = referenceEditor;
      this.host.render();
    });
    const referenceSave = document.createElement("button");
    referenceSave.type = "submit";
    referenceSave.textContent = referenceEditor.recordId ? "Save changes" : "Save reference";
    referenceSave.dataset.focusId = "reference-save";
    referenceForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.host.disabledState) return;
      referenceEditor.title = referenceTitle.value;
      referenceEditor.areaId = referenceArea.value;
      fieldControls.forEach((controls, index) => {
        referenceEditor.fields[index].label = controls.labelInput.value;
        referenceEditor.fields[index].value = controls.valueInput.value;
      });
      const result = validateReferenceRecord(referenceEditor.title, referenceEditor.fields);
      this.host.showFieldError(referenceTitle, referenceTitleError, result.errors.title);
      this.host.showFieldError(addReferenceField, referenceCountError, result.errors.count);
      result.errors.fields.forEach((errors, index) => {
        const controls = fieldControls[index];
        this.host.showFieldError(controls.labelInput, controls.labelError, errors.label);
        this.host.showFieldError(controls.valueInput, controls.valueError, errors.value);
      });
      if (!result.valid) {
        const invalid = referenceTitleError.textContent
          ? referenceTitle
          : referenceCountError.textContent
            ? addReferenceField
            : fieldControls.find((controls) => controls.labelError.textContent || controls.valueError.textContent);
        (invalid?.labelError?.textContent ? invalid.labelInput : invalid?.valueError?.textContent ? invalid.valueInput : invalid)?.focus();
        return;
      }
      this.host.dispatch("save-reference-record", {
        recordId: referenceEditor.recordId,
        title: result.title,
        areaId: referenceArea.value || null,
        fields: result.fields,
      });
    });
    referenceForm.append(referenceTitleLabel, referenceTitle, referenceTitleError, referenceAreaLabel, referenceArea, fieldHeading, referenceCountError, referenceFields, addReferenceField, referenceSave);
    const referenceList = document.createElement("ul");
    for (const record of this.host.referenceRecords.filter((item) => !item.archived)) {
      const row = document.createElement("li");
      row.className = "reference-row";
      row.dataset.recordId = record.recordId;
      row.tabIndex = -1;
      const title = document.createElement("h3");
      title.textContent = record.title;
      row.append(title);
      const fields = document.createElement("dl");
      for (const field of record.fields) {
        const label = document.createElement("dt"); label.textContent = field.label;
        const value = document.createElement("dd"); value.textContent = field.value;
        fields.append(label, value);
      }
      row.append(fields);
      row.append(this.host.makeAttachmentControl("reference-record", record.recordId, record.title));
      const maintenance = document.createElement("section");
      maintenance.dataset.feature = "maintenance";
      const maintenanceHeading = document.createElement("h4"); maintenanceHeading.textContent = "Maintenance";
      maintenance.append(maintenanceHeading);
      const history = document.createElement("ul");
      for (const event of this.host.maintenanceEvents.filter((entry) => entry.recordId === record.recordId && !entry.archived).sort((a, b) => b.performedOn - a.performedOn || a.maintenanceId.localeCompare(b.maintenanceId))) {
        const entry = document.createElement("li");
        entry.dataset.maintenanceId = event.maintenanceId;
        entry.tabIndex = -1;
        const date = String(event.performedOn); const next = event.nextOn ? ` · Next around ${String(event.nextOn).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")}` : "";
        entry.textContent = `${event.summary} · ${date.slice(4,6)}/${date.slice(6,8)}/${date.slice(0,4)}${next}`;
        entry.append(this.host.makeAttachmentControl("maintenance", event.maintenanceId, event.summary));
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Archive event"; remove.setAttribute("aria-label", `Archive maintenance event: ${event.summary}`);
        remove.addEventListener("click", () => this.host.dispatch("archive-maintenance-event", { maintenanceId: event.maintenanceId }));
        entry.append(" ", remove); history.append(entry);
      }
      maintenance.append(history);
      const form = document.createElement("form"); form.noValidate = true;
      const draft = this.host.maintenanceDraft(record.recordId);
      const summary = document.createElement("input"); summary.required = true; summary.maxLength = 240; summary.setAttribute("aria-label", `Maintenance summary for ${record.title}`); summary.placeholder = "What was done?";
      const performed = document.createElement("input"); performed.type = "date"; performed.required = true; performed.setAttribute("aria-label", "Date performed");
      const nextOn = document.createElement("input"); nextOn.type = "date"; nextOn.setAttribute("aria-label", "Next date (optional)");
      const routine = document.createElement("select"); routine.setAttribute("aria-label", "Link a Routine (optional)");
      const none = document.createElement("option"); none.value = ""; none.textContent = "No linked Routine"; routine.append(none);
      for (const candidate of this.host.routineRecords.filter((item) => item.status === "active")) { const option = document.createElement("option"); option.value = candidate.routineId; option.textContent = candidate.text; routine.append(option); }
      summary.value = draft.summary;
      performed.value = draft.performed;
      nextOn.value = draft.nextOn;
      routine.value = draft.routineId;
      summary.dataset.focusId = `maintenance-summary-${record.recordId}`;
      const rememberDraft = () => this.host.updateMaintenanceDraft(record.recordId, {
        summary: summary.value,
        performed: performed.value,
        nextOn: nextOn.value,
        routineId: routine.value,
      });
      summary.addEventListener("input", rememberDraft);
      performed.addEventListener("input", rememberDraft);
      nextOn.addEventListener("input", rememberDraft);
      routine.addEventListener("change", rememberDraft);
      const addEvent = document.createElement("button"); addEvent.type = "submit"; addEvent.textContent = "Add maintenance";
      form.addEventListener("submit", (event) => { event.preventDefault(); if (this.host.disabledState || !summary.value.trim() || !performed.value) return; rememberDraft(); const numericDate = (value) => value ? Number(value.replaceAll("-", "")) : null; this.host.dispatch("save-maintenance-event", { maintenanceId: crypto.randomUUID().replaceAll("-", ""), recordId: record.recordId, performedOn: numericDate(performed.value), summary: summary.value.trim(), nextOn: numericDate(nextOn.value), routineId: routine.value || null }); });
      form.append(summary, performed, nextOn, routine, addEvent); maintenance.append(form); row.append(maintenance);
      if (record.areaId) {
        const linked = this.host.areaRecords.find((candidate) => candidate.areaId === record.areaId);
        const areaText = document.createElement("small");
        areaText.textContent = linked ? `${linked.name}${linked.archived ? " (archived Area)" : ""}` : "Archived Area";
        row.append(areaText);
      }
      const edit = document.createElement("button");
      edit.type = "button"; edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        this.host.referenceEditor = { recordId: record.recordId, title: record.title, areaId: record.areaId ?? "", fields: record.fields.map((field) => ({ ...field })) };
        this.host.pendingFocus = "reference-title";
        this.host.render();
      });
      const archive = document.createElement("button");
      archive.type = "button"; archive.textContent = "Archive";
      archive.addEventListener("click", () => this.host.dispatch("archive-reference-record", { recordId: record.recordId }));
      row.append(edit, archive);
      referenceList.append(row);
    }
    references.append(referenceHeading, referenceHint, referenceForm, referenceList);
    return references;
  }
}
