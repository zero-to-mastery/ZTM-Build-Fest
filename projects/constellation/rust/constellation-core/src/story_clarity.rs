//! Deterministic presentation diagnostics for already-composed project stories.
//! This is not a candidate score and never evaluates a developer.
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

pub const STORY_CLARITY_VERSION: u32 = 1;
const MAX_BYTES: usize = 1_000_000;
const MAX_PROJECTS: usize = 512;
const MAX_LABELS: usize = 1024;
const MAX_RELATIONSHIPS: usize = 4096;
const MAX_GROUPS: usize = 128;
const MAX_DIAGNOSTICS: usize = 256;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rect { x: f64, y: f64, width: f64, height: f64 }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    #[serde(default)] role: String,
    #[serde(default)] x: f64,
    #[serde(default)] y: f64,
    #[serde(default)] radius: f64,
    #[serde(default)] prominence: f64,
    #[serde(default)] manual_position: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Label {
    id: String,
    #[serde(default)] project_id: Option<String>,
    #[serde(default)] group_id: Option<String>,
    #[serde(default)] text: String,
    bounds: Rect,
    #[serde(default)] priority: u32,
    #[serde(default)] visible: bool,
    #[serde(default)] manual_position: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Relationship {
    id: String, from: String, to: String,
    #[serde(default)] kind: String,
    #[serde(default)] style: String,
    #[serde(default)] evidence: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Group { id: String, #[serde(default)] project_ids: Vec<String>, #[serde(default)] bounds: Option<Rect> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    width: f64, height: f64,
    #[serde(default)] projects: Vec<Project>,
    #[serde(default)] labels: Vec<Label>,
    #[serde(default)] relationships: Vec<Relationship>,
    #[serde(default)] groups: Vec<Group>,
    #[serde(default)] legend: Option<Rect>,
    #[serde(default)] manual_layout: bool,
}

fn valid_id(value: &str) -> bool { !value.is_empty() && value.len() <= 200 && !value.chars().any(char::is_control) }
fn valid_rect(r: &Rect, width: f64, height: f64) -> bool {
    [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite() && v.abs() <= 100_000.0)
        && r.width >= 0.0 && r.height >= 0.0 && r.width <= width * 4.0 && r.height <= height * 4.0
}
fn overlaps(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}
fn segment_hits_rect(x1: f64, y1: f64, x2: f64, y2: f64, r: &Rect) -> bool {
    // Liang-Barsky clipping, stable for axis-aligned estimated label boxes.
    let dx=x2-x1; let dy=y2-y1;
    let p=[-dx,dx,-dy,dy]; let q=[x1-r.x,r.x+r.width-x1,y1-r.y,r.y+r.height-y1];
    let (mut lo,mut hi)=(0.0_f64,1.0_f64);
    for i in 0..4 { if p[i].abs()<f64::EPSILON { if q[i]<0.0 { return false; } } else { let t=q[i]/p[i]; if p[i]<0.0 { lo=lo.max(t); } else { hi=hi.min(t); } if lo>hi { return false; } } }
    true
}
fn diagnostic(code: &str, ids: Vec<String>, severity: &str) -> serde_json::Value {
    serde_json::json!({"code":code,"ids":ids,"severity":severity})
}
fn manually_fixed(label: &Label, input: &Input, projects: &BTreeMap<&str, &Project>) -> bool {
    label.manual_position || input.manual_layout || label.project_id.as_deref()
        .and_then(|id| projects.get(id).copied()).is_some_and(|project| project.manual_position)
}

pub fn analyze(json: &str) -> Result<String, String> {
    if json.len() > MAX_BYTES { return Err("Story Clarity input exceeds 1 MiB".into()); }
    let mut input: Input = serde_json::from_str(json).map_err(|e| format!("Invalid Story Clarity input: {e}"))?;
    if !input.width.is_finite() || !input.height.is_finite() || input.width <= 0.0 || input.height <= 0.0 || input.width > 100_000.0 || input.height > 100_000.0 {
        return Err("Story Clarity presentation dimensions are invalid".into());
    }
    if input.projects.len()>MAX_PROJECTS || input.labels.len()>MAX_LABELS || input.relationships.len()>MAX_RELATIONSHIPS || input.groups.len()>MAX_GROUPS {
        return Err("Story Clarity input exceeds collection bounds".into());
    }
    if input.projects.iter().any(|p| !valid_id(&p.id) || !p.x.is_finite() || !p.y.is_finite() || !p.radius.is_finite() || !p.prominence.is_finite() || p.x.abs()>100_000.0 || p.y.abs()>100_000.0 || p.radius<0.0 || p.radius>10_000.0 || p.prominence<0.0 || p.prominence>10_000.0)
        || input.labels.iter().any(|l| !valid_id(&l.id) || !valid_rect(&l.bounds,input.width,input.height) || l.text.len()>1024)
        || input.relationships.iter().any(|e| !valid_id(&e.id) || !valid_id(&e.from) || !valid_id(&e.to) || e.kind.len()>80 || e.style.len()>80 || e.evidence.len()>64)
        || input.groups.iter().any(|g| !valid_id(&g.id) || g.project_ids.len()>MAX_PROJECTS || g.bounds.as_ref().is_some_and(|b| !valid_rect(b,input.width,input.height)))
        || input.legend.as_ref().is_some_and(|b| !valid_rect(b,input.width,input.height)) {
        return Err("Story Clarity contains invalid or unbounded geometry".into());
    }
    input.projects.sort_by(|a,b| a.id.cmp(&b.id)); input.labels.sort_by(|a,b| a.id.cmp(&b.id));
    input.relationships.sort_by(|a,b| a.id.cmp(&b.id)); input.groups.sort_by(|a,b| a.id.cmp(&b.id));
    let projects: BTreeMap<_,_> = input.projects.iter().map(|p|(p.id.as_str(),p)).collect();
    let mut diagnostics=Vec::<(String,Vec<String>,String,serde_json::Value)>::new();
    let mut suggestions=Vec::<serde_json::Value>::new();
    let mut shown: Vec<&Label> = input.labels.iter().filter(|l| l.visible && !l.text.is_empty()).collect();
    shown.sort_by(|a,b| a.id.cmp(&b.id));
    for label in &shown {
        let b=&label.bounds;
        if b.x<0.0 || b.y<0.0 || b.x+b.width>input.width || b.y+b.height>input.height {
            let ids=vec![label.id.clone()];
            diagnostics.push(("label-out-of-bounds".into(),ids.clone(),"warning".into(),diagnostic("label-out-of-bounds",ids,"warning")));
            if !manually_fixed(label,&input,&projects) { suggestions.push(serde_json::json!({"kind":"move-label","labelId":label.id,"preserveManual":true})); }
        }
    }
    for i in 0..shown.len() { for j in i+1..shown.len() {
        if overlaps(&shown[i].bounds,&shown[j].bounds) {
            let mut ids=vec![shown[i].id.clone(),shown[j].id.clone()];
            ids.extend(shown[i].group_id.iter().cloned()); ids.extend(shown[j].group_id.iter().cloned()); ids.sort(); ids.dedup();
            diagnostics.push(("label-collision".into(),ids.clone(),"warning".into(),diagnostic("label-collision",ids.clone(),"warning")));
            if !manually_fixed(shown[i],&input,&projects) || !manually_fixed(shown[j],&input,&projects) {
                let lower=if (shown[i].priority, &shown[i].id) <= (shown[j].priority,&shown[j].id) { shown[i] } else { shown[j] };
                if !manually_fixed(lower,&input,&projects) { suggestions.push(serde_json::json!({"kind":"suppress-or-offset-label","labelId":lower.id,"preserveManual":true})); }
            }
        }
    }}
    let featured: Vec<_>=input.projects.iter().filter(|p|p.role=="featured").collect();
    let supporting: Vec<_>=input.projects.iter().filter(|p|p.role=="supporting").collect();
    let featured_prominence=featured.iter().map(|p|p.prominence.max(p.radius)).fold(0.0_f64,f64::max);
    let supporting_prominence=supporting.iter().map(|p|p.prominence.max(p.radius)).fold(0.0_f64,f64::max);
    if !featured.is_empty() && (featured_prominence<=0.0 || (!supporting.is_empty() && featured_prominence<supporting_prominence)) {
        let ids:Vec<String>=featured.iter().map(|p|p.id.clone()).collect();
        diagnostics.push(("featured-insufficient-prominence".into(),ids.clone(),"warning".into(),diagnostic("featured-insufficient-prominence",ids,"warning")));
        if !input.manual_layout { suggestions.push(serde_json::json!({"kind":"increase-featured-prominence","preserveManual":true})); }
    }
    if !featured.is_empty() && !supporting.is_empty() {
        let f=featured_prominence;
        let s=supporting_prominence;
        if f>0.0 && s>=f*0.9 {
            let mut ids:Vec<_>=featured.iter().chain(supporting.iter()).map(|p|p.id.clone()).collect(); ids.sort(); ids.dedup();
            diagnostics.push(("weak-featured-supporting-hierarchy".into(),ids.clone(),"info".into(),diagnostic("weak-featured-supporting-hierarchy",ids,"info")));
            if !input.manual_layout { suggestions.push(serde_json::json!({"kind":"separate-featured-hierarchy","preserveManual":true})); }
        }
    }
    let project_edges:Vec<_>=input.relationships.iter().filter(|e|projects.contains_key(e.from.as_str()) && projects.contains_key(e.to.as_str())).collect();
    let possible=input.projects.len().saturating_mul(input.projects.len().saturating_sub(1))/2;
    if possible>0 && project_edges.len() as f64 / possible as f64 > 0.45 {
        let ids:Vec<String>=project_edges.iter().map(|e|e.id.clone()).collect();
        diagnostics.push(("excessive-connection-density".into(),ids.clone(),"warning".into(),diagnostic("excessive-connection-density",ids,"warning")));
        suggestions.push(serde_json::json!({"kind":"reduce-relationship-annotations","preserveEvidence":true}));
    }
    for edge in &project_edges {
        let (Some(a),Some(b))=(projects.get(edge.from.as_str()),projects.get(edge.to.as_str())) else {continue};
        for label in &shown {
            if label.project_id.as_deref().is_some_and(|id|id==edge.from||id==edge.to) {continue;}
            if segment_hits_rect(a.x,a.y,b.x,b.y,&label.bounds) {
                let mut ids=vec![edge.id.clone(),label.id.clone()]; ids.sort();
                diagnostics.push(("relationship-crosses-important-label".into(),ids.clone(),"warning".into(),diagnostic("relationship-crosses-important-label",ids,"warning")));
            }
        }
    }
    let mut styles:BTreeMap<&str,BTreeSet<&str>>=BTreeMap::new();
    for edge in &project_edges { styles.entry(edge.kind.as_str()).or_default().insert(edge.style.as_str()); }
    if styles.len()>1 && styles.values().any(|s|s.len()<2) {
        let ids:Vec<String>=project_edges.iter().map(|e|e.id.clone()).collect();
        diagnostics.push(("unclear-relationship-differentiation".into(),ids.clone(),"info".into(),diagnostic("unclear-relationship-differentiation",ids,"info")));
        suggestions.push(serde_json::json!({"kind":"differentiate-relationship-patterns","preserveColorMeaning":true}));
    }
    for group in &input.groups {
        let members:Vec<_>=group.project_ids.iter().filter_map(|id|projects.get(id.as_str()).copied()).collect();
        if members.len()>=5 {
            let (min_x,max_x,min_y,max_y)=members.iter().fold((f64::INFINITY,f64::NEG_INFINITY,f64::INFINITY,f64::NEG_INFINITY),|(lx,hx,ly,hy),p|(lx.min(p.x),hx.max(p.x),ly.min(p.y),hy.max(p.y)));
            let area=(max_x-min_x).max(1.0)*(max_y-min_y).max(1.0);
            if members.len() as f64 / area.sqrt().max(1.0) > 0.08 {
                let ids=vec![group.id.clone()];
                diagnostics.push(("overcrowded-technical-region".into(),ids.clone(),"warning".into(),diagnostic("overcrowded-technical-region",ids,"warning")));
            }
        }
    }
    if let Some(legend)=&input.legend { for label in &shown { if overlaps(legend,&label.bounds) { let mut ids=vec![label.id.clone(),"legend".into()]; ids.sort(); diagnostics.push(("legend-overlaps-label".into(),ids.clone(),"warning".into(),diagnostic("legend-overlaps-label",ids,"warning"))); } } }
    diagnostics.sort_by(|a,b|(&a.0,&a.1,&a.2).cmp(&(&b.0,&b.1,&b.2))); diagnostics.truncate(MAX_DIAGNOSTICS);
    suggestions.sort_by_key(|s|s.to_string()); suggestions.dedup_by_key(|s|s.to_string()); suggestions.truncate(MAX_DIAGNOSTICS);
    let output=serde_json::json!({"version":STORY_CLARITY_VERSION,"diagnostics":diagnostics.into_iter().map(|item|item.3).collect::<Vec<_>>(),"suggestions":suggestions});
    serde_json::to_string(&output).map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::analyze;
    #[test]
    fn detects_layout_issues_with_stable_ids_and_suggestions() {
        let input=r#"{"width":480,"height":240,"projects":[{"id":"a","role":"featured","x":50,"y":50},{"id":"b","role":"supporting","x":60,"y":50}],"labels":[{"id":"label:a","projectId":"a","text":"Alpha","bounds":{"x":20,"y":20,"width":80,"height":24},"visible":true},{"id":"label:b","projectId":"b","text":"Beta","bounds":{"x":60,"y":20,"width":80,"height":24},"visible":true}],"relationships":[{"id":"rel:a:b","from":"a","to":"b","kind":"language","style":"solid"}]}"#;
        let result:serde_json::Value=serde_json::from_str(&analyze(input).unwrap()).unwrap();
        assert!(result["diagnostics"].as_array().unwrap().iter().any(|d|d["code"]=="label-collision"));
        assert!(result["suggestions"].as_array().unwrap().iter().any(|d|d["labelId"]=="label:a"));
    }
    #[test]
    fn rejects_unbounded_dimensions_and_collections() {
        assert!(analyze(r#"{"width":0,"height":100}"#).is_err());
        let projects=vec![r#"{"id":"x"}"#;513].join(",");
        assert!(analyze(&format!(r#"{{"width":100,"height":100,"projects":[{projects}]}}"#)).unwrap_err().contains("bounds"));
    }
    #[test]
    fn reordered_records_return_identical_diagnostics() {
        let a=r#"{"width":100,"height":100,"projects":[{"id":"b","role":"supporting","prominence":3},{"id":"a","role":"featured","prominence":3}],"labels":[]}"#;
        let b=r#"{"width":100,"height":100,"projects":[{"id":"a","role":"featured","prominence":3},{"id":"b","role":"supporting","prominence":3}],"labels":[]}"#;
        assert_eq!(analyze(a).unwrap(),analyze(b).unwrap());
    }
}
