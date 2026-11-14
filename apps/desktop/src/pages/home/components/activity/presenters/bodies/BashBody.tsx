import { Terminal } from '../../../Terminal';
import { readInput, readOutputRecord, readString, type ToolItem } from '../../model';

export function BashBody({ item }: { item: ToolItem }) {
    const input = readInput(item);
    const output = readOutputRecord(item);
    const command = readString(input, ['command']);
    const stdout = readString(output, ['stdout']);
    const stderr = readString(output, ['stderr']);
    const running = item.status === 'preparing' || item.status === 'running';
    return <Terminal title={command || '终端'} stdout={stdout} stderr={stderr} running={running} />;
}
