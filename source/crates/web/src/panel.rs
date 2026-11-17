use anyhow::{Result, bail};
use serde::Serialize;
use tidewater_command_panel as panel;
use tidewater_command_panel::{Act, Effect, Entry, Label, Menu, Mode, PanelState, Target, UnitInfo, WorldState};
use tidewater_formats::{install::Install, tbl::StringTable};
use tidewater_sim::economy::JobKind;
use tidewater_sim::{Command, World};

pub struct Text {
    table: StringTable,
    labels: Vec<Label>,
    names: Vec<Option<String>>,
}

impl Text {
    pub fn load(install: &mut Install) -> Result<Self> {
        let table = StringTable::parse(&install.read("rez\\stat_txt.tbl")?)?;
        let labels = (0..table.0.len())
            .map(|i| panel::parse_label(&super::campaign::decode(&table.0[i])))
            .collect();
        let names = (0..=u8::MAX)
            .map(|kind| {
                panel::unit_name_entry(kind).and_then(|entry| {
                    let bytes = table.0.get(usize::from(entry - 1))?;
                    Some(super::campaign::decode(bytes).trim().to_owned())
                })
            })
            .collect();
        Ok(Self { table, labels, names })
    }

    pub fn unit_name(&self, kind: u8) -> Option<&str> {
        self.names[usize::from(kind)].as_deref()
    }

    fn label(&self, entry: u16) -> Label {
        self.labels
            .get(usize::from(entry.saturating_sub(1)))
            .cloned()
            .unwrap_or_else(|| panel::parse_label(""))
    }

    pub fn message(&self, entry: u16) -> String {
        self.table
            .0
            .get(usize::from(entry.saturating_sub(1)))
            .map(|entry| {
                super::campaign::decode(entry)
                    .chars()
                    .filter(|c| !c.is_control())
                    .collect()
            })
            .unwrap_or_else(|| "Action is unavailable".to_string())
    }
}

#[derive(Serialize)]
pub struct Action {
    pub op: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<u8>,
    pub label: String,
    pub icon: u16,
    pub slot: u8,
    pub cost: [u32; 3],
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(rename = "reasonEntry", skip_serializing_if = "Option::is_none")]
    pub reason_entry: Option<u16>,
    pub advanced: bool,
    pub string: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spell: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<WorkSubject>,
}

#[derive(Serialize)]
pub struct WorkSubject {
    pub unit: u32,
    pub op: &'static str,
    pub kind: u8,
    pub colour: u8,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub string: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
}

struct Button {
    entry: &'static Entry,
    advanced: bool,
}

pub struct Commands<'a> {
    state: WorldState<'a>,
    selection: Vec<UnitInfo>,
    buttons: Vec<Button>,
}

impl<'a> Commands<'a> {
    pub fn new(world: &'a World, local: u8) -> Self {
        let state = WorldState { world, local };
        let selection = world
            .selection(local)
            .into_iter()
            .filter_map(|id| state.unit(id))
            .collect::<Vec<_>>();
        let current = panel::choose_set(Mode::None, &selection, &state);
        let mut buttons = Vec::new();
        for entry in panel::fill(current, &state, &selection).into_iter().flatten() {
            if let Act::Menu(menu) = entry.act {
                // The browser groups the original build menu buttons locally.
                let group = panel::choose_set(Mode::Menu(menu), &selection, &state);
                buttons.extend(
                    panel::fill(group, &state, &selection)
                        .into_iter()
                        .flatten()
                        .filter(|entry| matches!(entry.act, Act::Build(_)))
                        .map(|entry| Button {
                            entry,
                            advanced: menu == Menu::Advanced,
                        }),
                );
            } else {
                buttons.push(Button { entry, advanced: false });
            }
        }
        Self {
            state,
            selection,
            buttons,
        }
    }

    fn effect(&self, entry: &Entry) -> Effect {
        panel::activate(entry, &self.state, &self.selection)
    }

    fn work_subject(&self, act: Act, text: &Text) -> Option<WorkSubject> {
        let world = self.state.world;
        let unit = world.unit(self.selection.first()?.id)?;
        let colour = world.players[unit.colour as usize].colour;
        let unit_subject = |op, kind| WorkSubject {
            unit: unit.id.0,
            op,
            kind,
            colour,
            label: text.unit_name(kind).unwrap_or("").to_owned(),
            icon: None,
            string: None,
            level: None,
        };
        match act {
            Act::CancelConstruction => Some(unit_subject("build", unit.kind)),
            Act::CancelJob => match unit.job?.kind {
                JobKind::Train(kind) => Some(unit_subject("train", kind)),
                JobKind::Upgrade(kind) => Some(unit_subject("upgrade", kind)),
                JobKind::Research(kind) | JobKind::Spell(kind) => {
                    let entries = panel::kind_set(unit.kind).unwrap_or_default().iter().flat_map(|group| group.iter());
                    let entry = entries.clone().find(|entry| entry.act == Act::Research(kind));
                    let label = entry.map(|entry| panel::tooltip(entry, &text.label(entry.string)))
                        .filter(|label| !label.is_empty())
                        .or_else(|| tidewater_formats::ugrd::NAMES.get(usize::from(kind)).map(|name| (*name).to_owned()))
                        .unwrap_or_default();
                    // Some successive research levels share the original tooltip text.
                    let level = entry.and_then(|entry| {
                        let mut count = 0;
                        let mut level = 0;
                        for other in entries.filter(|other| other.string == entry.string) {
                            count += 1;
                            if other.act == entry.act {
                                level = count;
                            }
                        }
                        (count > 1).then_some(level)
                    });
                    // The original production panel takes research art from live upgrade data.
                    let icon = world.upgrade_data.0.get(usize::from(kind))
                        .map(|upgrade| if upgrade.icon == 108 { 103 } else { upgrade.icon });
                    Some(WorkSubject {
                        unit: unit.id.0,
                        op: "research",
                        kind,
                        colour,
                        label,
                        icon,
                        string: entry.map(|entry| entry.string),
                        level,
                    })
                }
            },
            _ => None,
        }
    }

    fn action(&self, button: &Button, text: &Text) -> Option<Action> {
        let entry = button.entry;
        let effect = self.effect(entry);
        let act = entry.act;
        let mut target = None;
        let mut spell = None;
        let mut kind = None;
        let mut cost = [0; 3];
        let op = match act {
            Act::Target(aim) => {
                (target, spell) = target_key(aim);
                "target"
            }
            Act::Cast(n) if n != 48 => {
                (target, spell) = target_key(Target::Spell(n));
                "target"
            }
            Act::Cast(n) => {
                kind = Some(n);
                "cast"
            }
            Act::Unload if matches!(effect, Effect::SetMode(Mode::Target(_))) => {
                (target, spell) = target_key(Target::Unload);
                "target"
            }
            Act::Unload => "unload",
            Act::Stop => "stop",
            Act::StandGround => "hold",
            Act::ReturnGoods => "returnGoods",
            Act::Build(k) | Act::Train(k) | Act::Become(k) => {
                kind = Some(k);
                cost = self.state.kind_cost(k);
                match act {
                    Act::Build(_) => "build",
                    Act::Train(_) => "train",
                    _ => "upgrade",
                }
            }
            Act::Research(n) => {
                kind = Some(n);
                cost = self.state.upgrade_cost(n);
                "research"
            }
            Act::CancelConstruction | Act::CancelJob => "cancel",
            Act::Menu(_) | Act::Back | Act::LeaveMode => return None,
        };
        let label = panel::tooltip(entry, &text.label(entry.string));
        let reason_entry = match effect {
            Effect::Message(entry) => Some(entry),
            _ => None,
        };
        Some(Action {
            op,
            action: target,
            spell,
            kind,
            label,
            icon: entry.icon,
            slot: entry.slot,
            cost,
            enabled: !matches!(effect, Effect::Nothing | Effect::Message(_)),
            reason: reason_entry.map(|entry| text.message(entry)),
            reason_entry,
            advanced: button.advanced,
            string: entry.string,
            subject: if op == "cancel" { self.work_subject(act, text) } else { None },
        })
    }

    pub fn actions(&self, text: &Text) -> Vec<Action> {
        self.buttons
            .iter()
            .filter_map(|button| self.action(button, text))
            .collect()
    }

    fn require(
        &self,
        text: &Text,
        op: &str,
        kind: Option<u8>,
        action: Option<&str>,
        spell: Option<u8>,
    ) -> Result<Effect> {
        for button in &self.buttons {
            if self
                .action(button, text)
                .is_some_and(|item| item.op == op && item.kind == kind && item.action == action && item.spell == spell)
            {
                let effect = self.effect(button.entry);
                match effect {
                    Effect::Nothing => break,
                    Effect::Message(number) => bail!("{}", text.message(number)),
                    effect => return Ok(effect),
                }
            }
        }
        bail!("Action is unavailable")
    }

    pub fn command(&self, text: &Text, op: &str, kind: Option<u8>) -> Result<Command> {
        if let Effect::Send(command) = self.require(text, op, kind, None, None)? {
            return Ok(command);
        }
        bail!("Action requires a target")
    }

    pub fn placed(&self, text: &Text, kind: u8) -> Result<()> {
        self.require(text, "build", Some(kind), None, None)?;
        Ok(())
    }

    pub fn target(&self, text: &Text, action: &str, spell: Option<u8>) -> Result<Target> {
        if let Effect::SetMode(Mode::Target(aim)) = self.require(text, "target", None, Some(action), spell)? {
            return Ok(aim);
        }
        bail!("Action has no target")
    }
}

fn target_key(target: Target) -> (Option<&'static str>, Option<u8>) {
    let action = match target {
        Target::Move => "move",
        Target::Attack => "attack",
        Target::Patrol => "patrol",
        Target::Harvest => "harvest",
        Target::Repair => "repair",
        Target::AttackGround => "attackGround",
        Target::Demolish => "demolish",
        Target::Unload => "unload",
        Target::Spell(n) => return (Some("spell"), Some(n)),
    };
    (Some(action), None)
}
