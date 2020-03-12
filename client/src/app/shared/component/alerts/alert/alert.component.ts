import { Component, Input, Output, OnInit, EventEmitter } from '@angular/core';
import { Alert } from '../alert.interface';

@Component({
    selector: 'app-alert',
    templateUrl: './alert.component.html',
    styleUrls: ['./alert.component.css']
})
export class AlertComponent implements OnInit {
    @Input() alert: Alert;
    @Output() dismiss = new EventEmitter();

    private TIME_TO_DISMISS = 5000;
    private timer: any;

    ngOnInit() {
        this.setTimer();
    }

    private setTimer() {
        this.timer = setTimeout(() => {
            this.dismiss.emit(this.alert);
        }, this.TIME_TO_DISMISS);
    }

    public close() {
        clearTimeout(this.timer);
        this.dismiss.emit(this.alert);
    }

    public mouseIn() {
        clearTimeout(this.timer);
    }

    public mouseOut() {
        this.setTimer();
    }
}