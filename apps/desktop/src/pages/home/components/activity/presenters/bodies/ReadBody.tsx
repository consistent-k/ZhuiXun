import { langFromPath } from '../../format';
import { readInput, readOutputRecord, readString, type ToolItem } from '../../model';
import { CodePreview } from '../CodePreview';

export function ReadBody({ item }: { item: ToolItem }) {
    const output = readOutputRecord(item);
    const content = readString(output, ['content']);
    const input = readInput(item);
    const path = readString(input, ['path']);
    return <CodePreview text={content} lang={langFromPath(path)} />;
}
