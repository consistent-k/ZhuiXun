export type Teardown = () => void | Promise<void>;

export function createTeardownRegistry() {
    const tasks: Teardown[] = [];

    return {
        add(task: Teardown): void {
            tasks.push(task);
        },
        async run(): Promise<void> {
            const pending = tasks.splice(0).reverse();
            const errors: unknown[] = [];
            for (const task of pending) {
                try {
                    await task();
                } catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length > 0) throw new AggregateError(errors, '测试资源清理失败');
        }
    };
}
