import { langFromPath } from '../../format';
import { readInput, readString, type ToolItem } from '../../model';
import { CodePreview } from '../CodePreview';

export function WriteBody({ item }: { item: ToolItem }) {
    const input = readInput(item);
    const path = readString(input, ['path']);
    const content = readString(input, ['content']);
    return <CodePreview text={content} lang={langFromPath(path)} />;
}
