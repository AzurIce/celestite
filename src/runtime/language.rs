//! Native hosting for the read-only language service. Resource reads reuse the
//! preview grant and observation boundary; editor ownership stays independent.
use super::{Session, lock, no_local_resources};
use celestite_core::{
    error::EditorResult,
    language::{LanguageResources, LanguageService},
    preview::PreviewResource,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum LanguageCommand {
    Message { message: String },
    Invalidate,
    Reset,
}

impl Session {
    pub(crate) fn language(&self, command: LanguageCommand) -> EditorResult<Vec<String>> {
        let root = self
            .descriptor
            .root
            .as_ref()
            .ok_or_else(no_local_resources)?;
        let mut slot = lock(&self.language)?;
        if matches!(command, LanguageCommand::Reset) {
            *slot = None;
            return Ok(vec![]);
        }
        let service = slot.get_or_insert_with(|| LanguageService::native(root));
        let LanguageCommand::Message { message } = command else {
            service.invalidate_resources();
            return Ok(vec![]);
        };
        let mut step = service.handle(&message);
        let mut messages = Vec::new();
        loop {
            messages.extend(step.messages);
            if step.resource_requests.is_empty() {
                return Ok(messages);
            }
            let context = step
                .context
                .expect("resource requests carry their source context");
            let mut resources = LanguageResources::default();
            for request in step.resource_requests {
                let path = request.path.clone();
                let answer = self
                    .read_resource(&context, request)
                    .unwrap_or_else(|error| PreviewResource {
                        kind: None,
                        data: None,
                        error: Some(error.message),
                    });
                resources.resources.insert(path, answer);
            }
            step = service.provide(resources);
        }
    }
}
