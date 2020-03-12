import { Injectable } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { _ } from 'underscore/underscore';
import { JiraService } from 'src/app/service/jira.service';
import { TogglService } from 'src/app/service/toggl.service';
import { TimeEntry } from 'src/app/model/time-entry.interface';
import { Task } from 'src/app/model/task.interface';
import { TaskTranslator } from 'src/app/translator/task.translator';
import { TimeEntryTranslator } from 'src/app/translator/time-entry.translator';
import { extractTaskKey } from 'src/app/shared/common.extractor';
import { doUnsubscribe, isSubscribed } from 'src/app/shared/common.subscription';
import { SettingsSingleton } from 'src/app/service/settings.singleton';
import { AlertService } from 'src/app/shared/component/alerts/alert.service';
import { WorklogRegistration } from 'src/app/model/worklog-registration.interface';
import { WorklogRegistrationTranslator } from 'src/app/translator/worklog-registration.translator';
import { WorklogProcessService } from './worklog-process.service';
import { TimeEntryOperation } from './time-entry-operation.enum';

@Injectable({
    providedIn: 'root'
})
export class TimeEntriesFacade {
    constructor(
        private jira: JiraService,
        private toggl: TogglService,
        private settings: SettingsSingleton,
        private alertService: AlertService,
        private worklogProcessService: WorklogProcessService) { }

    private timeEntries: TimeEntry[] = [];
    private uniqueTaskKeys: string[] = [];
    private tasks: Task[] = [];

    private taskQuantity = 0;
    private processedTasks = 0;

    private tasksSubject = new Subject<Task[]>();
    private completionSubject = new Subject<number>();

    private taskTranslator = new TaskTranslator();
    private timeEntryTranslator = new TimeEntryTranslator();
    private worklogRegistrationTranslator = new WorklogRegistrationTranslator();

    private timeEntriesSubscription: Subscription;
    private tasksSubscriptions: Subscription[] = [];
    private worklogProcessSubscription: Subscription;

    public getAllTasksToRegisterTimeEntry(start: string, end: string) {
        this.timeEntriesSubscription = this.toggl.getTimeEntries(start, end, this.getTogglToken())
            .subscribe((timeEntries: any[]) => {
                this.clear();
                this.getAllTimeEntries(timeEntries);
                this.getUniqueTaskKeys();
                this.taskQuantity = this.uniqueTaskKeys.length;
                this.getAllTasks();
            });
    }

    private getTogglToken(): string {
        return btoa(`${this.settings.togglToken}:api_token`);
    }

    private clear() {
        this.timeEntries.splice(0, this.timeEntries.length);
        this.uniqueTaskKeys.splice(0, this.uniqueTaskKeys.length);
        this.tasks.splice(0, this.tasks.length);
        this.taskQuantity = 0;
        this.processedTasks = 0;
    }

    private getAllTimeEntries(timeEntries: any[]) {
        timeEntries.forEach(timeEntry => {
            if (this.isJiraTask(timeEntry)) {
                this.timeEntries.push(this.timeEntryTranslator.translate(timeEntry));
            }
        });
    }

    private isJiraTask(timeEntry: any): boolean {
        return !!extractTaskKey(timeEntry.description);
    }

    private getUniqueTaskKeys() {
        this.uniqueTaskKeys = _.unique(
            this.timeEntries.map(timeEntry => extractTaskKey(timeEntry.description))
        );
    }

    private getAllTasks() {
        this.uniqueTaskKeys.forEach(taskKey => {
            this.getTask(taskKey);
        });
    }

    private getTask(key: string) {
        const subscription = this.jira.getTask(key, this.getJiraToken())
            .subscribe((task: any) => {
                const translatedTask = this.taskTranslator.translate(task);
                translatedTask.timeEntries = this.getTaskTimeEntries(task);
                this.tasks.push(translatedTask);

                this.tasksSubject.next(this.tasks);

                this.setCompletion(TimeEntryOperation.LOAD);
            });

        this.tasksSubscriptions.push(subscription);
    }

    private getJiraToken(): string {
        return btoa(`${this.settings.jiraUser}:${this.settings.jiraToken}`);
    }

    private getTaskTimeEntries(task: Task): TimeEntry[] {
        return this.timeEntries.filter(timeEntry => extractTaskKey(timeEntry.description) === task.key);
    }

    private setCompletion(operation: TimeEntryOperation) {
        this.processedTasks++;
        const completion = (this.processedTasks / (this.taskQuantity / 100));
        this.completionSubject.next(completion);

        if (completion === 100) {
            this.doUnsubscribeAll();

            this.alertService.success(this.getCompletionMessage(operation));
        }
    }

    private getCompletionMessage(operation: TimeEntryOperation): string {
        if (operation === TimeEntryOperation.LOAD) {
            return 'Time entries loaded successfully';
        } else if (operation === TimeEntryOperation.REGISTRATION) {
            return 'Time entries registered successfully';
        }

        return '';
    }

    private doUnsubscribeAll() {
        doUnsubscribe(this.timeEntriesSubscription);
        this.timeEntriesSubscription = null;

        this.tasksSubscriptions.forEach(subscription => doUnsubscribe(subscription));
        this.tasksSubscriptions.splice(0, this.tasksSubscriptions.length);
    }

    public registerWorklogs(timeEntriesId: number[]) {
        this.listenToProcess();

        this.taskQuantity = timeEntriesId.length;
        this.processedTasks = 0;
        this.setCompletion(TimeEntryOperation.REGISTRATION);

        const tasksToRegisterWorklog = this.getTasksToRegisterWorklog(timeEntriesId);

        this.worklogProcessService.init(tasksToRegisterWorklog);

        tasksToRegisterWorklog.forEach(taskToRegisterWorklog => {
            taskToRegisterWorklog.task.worklogs.forEach(worklog => {
                if (!worklog.oldId) {
                    this.registerNewWorklog(taskToRegisterWorklog.task.key, worklog);
                } else {
                    this.overwriteExistingWorklog(taskToRegisterWorklog.task.key, worklog);
                }
            });
        });
    }

    private listenToProcess() {
        if (isSubscribed(this.worklogProcessSubscription)) return;

        this.worklogProcessSubscription = this.worklogProcessService.getSubject()
            .subscribe(processes => {
                processes.forEach(process => {
                    const foundTask = this.tasks.find(task => task.key === process.task);
                    foundTask.status = process.status;
                });

                this.tasksSubject.next(this.tasks);
            });
    }

    private getTasksToRegisterWorklog(timeEntriesId: number[]): WorklogRegistration[] {
        const tasksToRegisterWorklog = [];

        this.tasks.forEach(task => {
            const taskToRegisterWorklog = this.worklogRegistrationTranslator.translate(task, timeEntriesId);
            if (taskToRegisterWorklog.task.worklogs.length) {
                tasksToRegisterWorklog.push(taskToRegisterWorklog);
            }
        });

        return tasksToRegisterWorklog;
    }

    private registerNewWorklog(taskKey: string, worklog: any) {
        this.jira.registerWorklog(taskKey, worklog, this.getJiraToken())
            .subscribe(() => {
                this.worklogProcessService.doProgress(taskKey);
            }, (error) => {
                this.worklogProcessService.throwError(taskKey);
            }, () => {
                this.setCompletion(TimeEntryOperation.REGISTRATION);
            });
    }

    private overwriteExistingWorklog(taskKey: string, worklog: any) {
        this.jira.deleteWorklog(taskKey, worklog.oldId, this.getJiraToken())
            .subscribe(null, null, () => {
                this.registerNewWorklog(taskKey, worklog);
            });
    }

    public getTasksSubject(): Subject<Task[]> {
        return this.tasksSubject;
    }

    public getCompletionSubject(): Subject<number> {
        return this.completionSubject;
    }

    public destroy() {
        doUnsubscribe(this.worklogProcessSubscription);
        this.worklogProcessSubscription = null;
    }
}
