import { defineVideo, type VideoDefinition } from '@opencut/sdk';
import fieldNotes from './field-notes.video.json' with { type: 'json' };

export default defineVideo(fieldNotes as VideoDefinition);
