# Visit State Machine Diagram

Aligned with [Use Cases](Use%20Cases.md), [Domain Model](Domain%20Model.md) and [State Transition Consistency](State%20Transition%20Consistency.md). Service and physical presence are independent dimensions.

## Service status

```mermaid
stateDiagram-v2
    [*] --> Waiting: UC-03 / register arrival and attributes
    Waiting --> Assigned: UC-04 [inside and no pending offer] / offer first Available
    Assigned --> Accepted: UC-05 [still inside] / accept and advance rotation
    Accepted --> Completed: UC-06 / record Visit purchase outcome
    Waiting --> Completed: UC-12 / record exit and purchase outcome
    Assigned --> Completed: UC-12 / record exit, outcome and pending turn completion
    Accepted --> Completed: UC-12 / record exit, outcome and turn completion
    Completed --> [*]
```

## Physical presence

```mermaid
stateDiagram-v2
    [*] --> Inside: UC-03 / set arrivedAt to registration time
    Inside --> Left: UC-12 / set departedAt to registration time
    Left --> [*]
```

A Completed visit can remain Inside until Receptionist marks exit. Left always implies service Completed and purchase outcome present. Sale / NoSale is recorded once on Visit, whether or not an Assignment exists. Completed without assignment is valid after a Waiting visitor departs. Description/demographic updates do not change these states and can complete after exit. Reset deletes old-run records, not a successful departure/completion transition.
