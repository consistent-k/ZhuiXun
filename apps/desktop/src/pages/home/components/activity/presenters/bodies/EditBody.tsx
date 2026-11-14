import { readInput, readString, type ToolItem } from '../../model';
import { DiffView } from '../DiffView';

export function EditBody({ item }: { item: ToolItem }) {
    const input = readInput(item);
    const oldText = readString(input, ['old_string']);
    const newText = readString(input, ['new_string']);
    return <DiffView oldText={oldText} newText={newText} />;
}
