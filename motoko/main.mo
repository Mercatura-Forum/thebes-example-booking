import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Int "mo:core/Int";
import Text "mo:core/Text";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Array "mo:core/Array";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Runtime "mo:core/Runtime";
import Result "mo:core/Result";
import Admin "mo:thebes-lib/Admin";

/// Harbor — an on-chain reservation engine.
///
/// The property this example proves: **a slot can never be booked beyond its
/// capacity, and every cent of deposit money is accounted for.** The original
/// version guarded a binary double-booking; this version generalises the guard
/// into a counting one (seats vs capacity), adds a booking lifecycle with a
/// cancellation-window refund policy, FIFO waitlists that auto-promote the
/// moment seats free up, and a schedule-integrity guard (a listing's slots can
/// never overlap in time). All of it is enforced atomically — no `await`
/// separates a check from its writes — and all of it is *publicly auditable*
/// through `invariantReportView`, an on-chain oracle that recomputes five
/// invariants from raw state on every call:
///
///   R1 capacity   — active seats on a slot never exceed capacity, and the
///                   denormalised counter equals the recomputed sum
///   R2 waitlist   — nobody waits while their party would fit (the head of a
///                   waitlist is always strictly larger than the free seats)
///   R3 escrow     — collected == held + refunded + forfeited + captured,
///                   with `held` recomputed from active bookings
///   R4 schedule   — no two open slots of one listing overlap in time
///   R5 index      — the per-customer booking index and the booking book agree
///
/// An empty report is the system saying: the guard held.
persistent actor Harbor {

  // ── Domain types ──

  type Listing = {
    id : Nat;
    name : Text;
    description : Text;
    kind : Text;               // small tag the UI uses for art: sail/ev/studio/court/sauna/loft…
    durationMinutes : Nat;     // slot length
    priceCents : Nat;          // deposit per seat
    capacity : Nat;            // default seats per slot
    cancelWindowMinutes : Nat; // free cancellation closes this long before start
    photoPath : ?Text;         // pointer into the media contract; bytes live there
    archived : Bool;
  };

  type Slot = {
    id : Nat;
    listingId : Nat;
    startNs : Int;
    endNs : Int;
    capacity : Nat;
    seatsBooked : Nat;         // seats held by ACTIVE (confirmed/checked-in) bookings
    closed : Bool;             // house-cancelled; kept for booking history
  };

  type BookingStatus = { #confirmed; #checkedIn; #completed; #cancelled; #noShow };

  type Booking = {
    id : Nat;
    listingId : Nat;
    slotId : Nat;
    customer : Principal;
    seats : Nat;
    depositCents : Nat;        // priceCents * seats, escrowed at booking time
    status : BookingStatus;
    promoted : Bool;           // true if this booking was auto-promoted from a waitlist
    createdAt : Int;
    decidedAt : ?Int;          // when it left the active pair (completed/cancelled/noShow)
  };

  type WaitEntry = { customer : Principal; seats : Nat; joinedAt : Int };

  type AuditEvent = {
    seq : Nat;
    at : Int;
    who : Principal;
    kind : Text;               // listing.add / slots.publish / booking.create / booking.cancel.refund / …
    refA : Nat;                // primary id (listing, slot or booking — see kind)
    refB : Nat;                // secondary id
    note : Text;
  };

  // ── Typed error taxonomy ──

  type Err = {
    #notAuthorized;
    #paused;
    #notFound : Text;
    #invalid : Text;
    #slotFull : { remaining : Nat };
    #scheduleConflict : Text;
    #windowClosed : Text;
    #stateError : Text;
  };

  func errText(e : Err) : Text {
    switch (e) {
      case (#notAuthorized) "Not authorized";
      case (#paused) "The business is paused";
      case (#notFound t) t # " not found";
      case (#invalid t) t;
      case (#slotFull r) "Only " # Nat.toText(r.remaining) # " seat(s) left on this slot";
      case (#scheduleConflict t) t;
      case (#windowClosed t) t;
      case (#stateError t) t;
    };
  };

  type R<T> = Result.Result<T, Err>;

  // ── State ──

  var nextListingId : Nat = 0;
  var nextSlotId : Nat = 0;
  var nextBookingId : Nat = 0;
  var nextAuditSeq : Nat = 0;

  let listings = Map.empty<Nat, Listing>();
  let slots = Map.empty<Nat, Slot>();
  let bookings = Map.empty<Nat, Booking>();
  let waitlists = Map.empty<Nat, [WaitEntry]>();          // slot id → FIFO queue
  let customerBookings = Map.empty<Principal, List.List<Nat>>();
  let audit = List.empty<AuditEvent>();

  // The escrow ledger. `held` is intentionally NOT stored — the oracle
  // recomputes it from active bookings so the counter can't drift silently.
  var collectedCents : Nat = 0;
  var refundedCents : Nat = 0;
  var forfeitedCents : Nat = 0;
  var capturedCents : Nat = 0;

  let maxWaitlist : Nat = 20;
  let maxSlotsPerPublish : Nat = 500;
  let nsPerMinute : Int = 60 * 1_000_000_000;

  // ── Admin surface (thebes-lib/Admin): owner claim/transfer, admins, pause ──

  var admin = Admin.init();

  public shared (msg) func claimOwner() : async Bool { Admin.claimOwner(admin, msg.caller) };
  public shared (msg) func transferOwner(n : Principal) : async Bool { Admin.transferOwner(admin, msg.caller, n) };
  public shared (msg) func addAdmin(w : Principal) : async Bool { Admin.addAdmin(admin, msg.caller, w) };
  public shared (msg) func removeAdmin(w : Principal) : async Bool { Admin.removeAdmin(admin, msg.caller, w) };
  public shared (msg) func setPaused(v : Bool) : async Bool { Admin.setPaused(admin, msg.caller, v) };
  public query func getOwner() : async ?Principal { Admin.getOwner(admin) };
  public query func getAdmins() : async [Principal] { Admin.getAdmins(admin) };
  public query func isPaused() : async Bool { Admin.isPaused(admin) };

  func isOwnerOrAdmin(caller : Principal) : Bool { Admin.isAdmin(admin, caller) };

  // ── Internals ──

  func logEvent(who : Principal, kind : Text, refA : Nat, refB : Nat, note : Text) {
    List.add(audit, { seq = nextAuditSeq; at = Time.now(); who; kind; refA; refB; note });
    nextAuditSeq += 1;
  };

  func remainingSeats(s : Slot) : Nat {
    if (s.seatsBooked >= s.capacity) 0 else s.capacity - s.seatsBooked;
  };

  func isActive(st : BookingStatus) : Bool {
    switch (st) { case (#confirmed or #checkedIn) true; case _ false };
  };

  func statusText(st : BookingStatus) : Text {
    switch (st) {
      case (#confirmed) "confirmed"; case (#checkedIn) "checked-in";
      case (#completed) "completed"; case (#cancelled) "cancelled"; case (#noShow) "no-show";
    };
  };

  func getListing(id : Nat) : ?Listing { Map.get(listings, Nat.compare, id) };
  func getSlot(id : Nat) : ?Slot { Map.get(slots, Nat.compare, id) };

  func indexBooking(customer : Principal, bookingId : Nat) {
    switch (Map.get(customerBookings, Principal.compare, customer)) {
      case (?l) List.add(l, bookingId);
      case null {
        let l = List.empty<Nat>();
        List.add(l, bookingId);
        Map.add(customerBookings, Principal.compare, customer, l);
      };
    };
  };

  func cancelDeadline(l : Listing, s : Slot) : Int {
    s.startNs - l.cancelWindowMinutes * nsPerMinute;
  };

  // Create a booking against a slot with free capacity. The caller must have
  // verified `seats <= remainingSeats(slot)` — this is the single write site,
  // so the check and both writes share one synchronous step.
  func writeBooking(customer : Principal, listing : Listing, slot : Slot, seats : Nat, promoted : Bool) : Booking {
    let deposit = listing.priceCents * seats;
    let b : Booking = {
      id = nextBookingId; listingId = listing.id; slotId = slot.id;
      customer; seats; depositCents = deposit; status = #confirmed;
      promoted; createdAt = Time.now(); decidedAt = null;
    };
    nextBookingId += 1;
    Map.add(bookings, Nat.compare, b.id, b);
    Map.add(slots, Nat.compare, slot.id, { slot with seatsBooked = slot.seatsBooked + seats });
    indexBooking(customer, b.id);
    collectedCents += deposit;
    logEvent(customer, if (promoted) "waitlist.promote" else "booking.create", b.id, slot.id,
      Nat.toText(seats) # " seat(s), deposit " # Nat.toText(deposit) # "c");
    b;
  };

  // After seats free up on a future slot, promote waitlist entries FIFO while
  // the head fits. Strictly in order — nobody may jump a bigger party ahead of
  // them, which is exactly what invariant R2 checks.
  func promoteWaitlist(slotId : Nat) {
    let now = Time.now();
    var keepGoing = true;
    while (keepGoing) {
      keepGoing := false;
      switch (getSlot(slotId)) {
        case null {};
        case (?slot) {
          if (not slot.closed and slot.startNs > now) {
            switch (Map.get(waitlists, Nat.compare, slotId)) {
              case (?queue) {
                if (queue.size() > 0) {
                  let head = queue[0];
                  switch (getListing(slot.listingId)) {
                    case (?listing) {
                      if (head.seats <= remainingSeats(slot)) {
                        ignore writeBooking(head.customer, listing, slot, head.seats, true);
                        let rest = Array.sliceToArray(queue, 1, queue.size());
                        if (rest.size() == 0) { ignore Map.take(waitlists, Nat.compare, slotId) }
                        else { Map.add(waitlists, Nat.compare, slotId, rest) };
                        keepGoing := true;
                      };
                    };
                    case null {};
                  };
                };
              };
              case null {};
            };
          };
        };
      };
    };
  };

  // ── Listings (owner-gated) ──

  func doAddListing(caller : Principal, name : Text, description : Text, kind : Text,
                    durationMinutes : Nat, priceCents : Nat, capacity : Nat,
                    cancelWindowMinutes : Nat, photoPath : ?Text) : R<Nat> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) return #err(#notAuthorized);
    if (Text.size(name) == 0) return #err(#invalid("A listing needs a name"));
    if (durationMinutes == 0) return #err(#invalid("Duration must be at least a minute"));
    if (capacity == 0) return #err(#invalid("Capacity must be at least one seat"));
    let id = nextListingId;
    nextListingId += 1;
    Map.add(listings, Nat.compare, id, {
      id; name; description; kind; durationMinutes; priceCents; capacity;
      cancelWindowMinutes; photoPath; archived = false;
    });
    logEvent(caller, "listing.add", id, 0, name);
    #ok(id);
  };

  public shared (msg) func addListing(name : Text, description : Text, kind : Text, durationMinutes : Nat, priceCents : Nat, capacity : Nat, cancelWindowMinutes : Nat, photoPath : ?Text) : async Result.Result<Nat, Text> {
    Result.mapErr(doAddListing(msg.caller, name, description, kind, durationMinutes, priceCents, capacity, cancelWindowMinutes, photoPath), errText);
  };
  public shared (msg) func addListingOrTrap(name : Text, description : Text, kind : Text, durationMinutes : Nat, priceCents : Nat, capacity : Nat, cancelWindowMinutes : Nat, photoPath : ?Text) : async Nat {
    switch (doAddListing(msg.caller, name, description, kind, durationMinutes, priceCents, capacity, cancelWindowMinutes, photoPath)) {
      case (#ok id) id; case (#err e) Runtime.trap(errText(e));
    };
  };

  func doUpdateListing(caller : Principal, id : Nat, name : Text, description : Text, kind : Text, priceCents : Nat, cancelWindowMinutes : Nat) : R<()> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) return #err(#notAuthorized);
    switch (getListing(id)) {
      case null #err(#notFound("Listing"));
      case (?l) {
        if (Text.size(name) == 0) return #err(#invalid("A listing needs a name"));
        Map.add(listings, Nat.compare, id, { l with name; description; kind; priceCents; cancelWindowMinutes });
        logEvent(caller, "listing.update", id, 0, name);
        #ok(());
      };
    };
  };
  public shared (msg) func updateListing(id : Nat, name : Text, description : Text, kind : Text, priceCents : Nat, cancelWindowMinutes : Nat) : async Result.Result<(), Text> {
    Result.mapErr(doUpdateListing(msg.caller, id, name, description, kind, priceCents, cancelWindowMinutes), errText);
  };
  public shared (msg) func updateListingOrTrap(id : Nat, name : Text, description : Text, kind : Text, priceCents : Nat, cancelWindowMinutes : Nat) : async () {
    switch (doUpdateListing(msg.caller, id, name, description, kind, priceCents, cancelWindowMinutes)) {
      case (#ok _) {}; case (#err e) Runtime.trap(errText(e));
    };
  };

  func doArchiveListing(caller : Principal, id : Nat, archived : Bool) : R<()> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) return #err(#notAuthorized);
    switch (getListing(id)) {
      case null #err(#notFound("Listing"));
      case (?l) {
        Map.add(listings, Nat.compare, id, { l with archived });
        logEvent(caller, if (archived) "listing.archive" else "listing.restore", id, 0, l.name);
        #ok(());
      };
    };
  };
  public shared (msg) func archiveListing(id : Nat, archived : Bool) : async Result.Result<(), Text> {
    Result.mapErr(doArchiveListing(msg.caller, id, archived), errText);
  };
  public shared (msg) func archiveListingOrTrap(id : Nat, archived : Bool) : async () {
    switch (doArchiveListing(msg.caller, id, archived)) { case (#ok _) {}; case (#err e) Runtime.trap(errText(e)) };
  };

  func doSetListingPhoto(caller : Principal, id : Nat, photoPath : Text) : R<()> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) return #err(#notAuthorized);
    switch (getListing(id)) {
      case null #err(#notFound("Listing"));
      case (?l) { Map.add(listings, Nat.compare, id, { l with photoPath = ?photoPath }); #ok(()) };
    };
  };
  public shared (msg) func setListingPhoto(id : Nat, photoPath : Text) : async Result.Result<(), Text> {
    Result.mapErr(doSetListingPhoto(msg.caller, id, photoPath), errText);
  };
  public shared (msg) func setListingPhotoOrTrap(id : Nat, photoPath : Text) : async () {
    switch (doSetListingPhoto(msg.caller, id, photoPath)) { case (#ok _) {}; case (#err e) Runtime.trap(errText(e)) };
  };

  // ── Schedule (owner-gated) ──

  // Overlap guard: a candidate window may not intersect any OPEN slot of the
  // same listing. Bookable time is a resource; publishing it twice is the
  // schedule-level double-booking.
  func overlapsExisting(listingId : Nat, startNs : Int, endNs : Int) : ?Slot {
    for ((_, s) in Map.entries(slots)) {
      if (s.listingId == listingId and not s.closed and s.startNs < endNs and startNs < s.endNs) {
        return ?s;
      };
    };
    null;
  };

  func doPublishSlots(caller : Principal, listingId : Nat, startNs : Int, endNs : Int, intervalMinutes : Nat, capacity : Nat) : R<Nat> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) return #err(#notAuthorized);
    switch (getListing(listingId)) {
      case null return #err(#notFound("Listing"));
      case (?l) {
        if (l.archived) return #err(#invalid("Listing is archived — restore it before publishing"));
        if (intervalMinutes == 0) return #err(#invalid("Interval must be greater than zero"));
        if (endNs <= startNs) return #err(#invalid("End time must be after start time"));
        let cap = if (capacity == 0) l.capacity else capacity;
        let stepNs : Int = intervalMinutes * nsPerMinute;
        let lenNs : Int = l.durationMinutes * nsPerMinute;
        // Validate the whole batch first, then insert — a batch either lands
        // completely or not at all.
        var cursor : Int = startNs;
        var count : Nat = 0;
        while (cursor < endNs) {
          if (count >= maxSlotsPerPublish) return #err(#invalid("One publish is capped at " # Nat.toText(maxSlotsPerPublish) # " slots"));
          switch (overlapsExisting(listingId, cursor, cursor + lenNs)) {
            case (?hit) return #err(#scheduleConflict("A slot starting at that time already overlaps slot #" # Nat.toText(hit.id) # " — the schedule can't double-book time"));
            case null {};
          };
          if (lenNs > stepNs) return #err(#scheduleConflict("Slots are " # Nat.toText(l.durationMinutes) # " min long — an interval of " # Nat.toText(intervalMinutes) # " min would make them overlap each other"));
          count += 1;
          cursor += stepNs;
        };
        cursor := startNs;
        var created : Nat = 0;
        while (cursor < endNs) {
          let id = nextSlotId;
          nextSlotId += 1;
          Map.add(slots, Nat.compare, id, {
            id; listingId; startNs = cursor; endNs = cursor + lenNs;
            capacity = cap; seatsBooked = 0; closed = false;
          });
          created += 1;
          cursor += stepNs;
        };
        logEvent(caller, "slots.publish", listingId, created, Nat.toText(created) # " slot(s), " # Nat.toText(cap) # " seat(s) each");
        #ok(created);
      };
    };
  };
  public shared (msg) func publishSlots(listingId : Nat, startNs : Int, endNs : Int, intervalMinutes : Nat, capacity : Nat) : async Result.Result<Nat, Text> {
    Result.mapErr(doPublishSlots(msg.caller, listingId, startNs, endNs, intervalMinutes, capacity), errText);
  };
  public shared (msg) func publishSlotsOrTrap(listingId : Nat, startNs : Int, endNs : Int, intervalMinutes : Nat, capacity : Nat) : async Nat {
    switch (doPublishSlots(msg.caller, listingId, startNs, endNs, intervalMinutes, capacity)) {
      case (#ok n) n; case (#err e) Runtime.trap(errText(e));
    };
  };

  // House-cancel a slot: every active booking is cancelled with a FULL refund
  // (the house broke the promise, the window does not apply), the waitlist is
  // dissolved, and the slot is kept (closed) so booking history stays whole.
  func doCloseSlot(caller : Principal, slotId : Nat) : R<Nat> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) return #err(#notAuthorized);
    switch (getSlot(slotId)) {
      case null #err(#notFound("Slot"));
      case (?slot) {
        if (slot.closed) return #err(#stateError("Slot is already closed"));
        var refunded : Nat = 0;
        for ((_, b) in Map.entries(bookings)) {
          if (b.slotId == slotId and isActive(b.status)) {
            Map.add(bookings, Nat.compare, b.id, { b with status = #cancelled; decidedAt = ?Time.now() });
            refundedCents += b.depositCents;
            refunded += 1;
            logEvent(caller, "booking.cancel.house", b.id, slotId, "house closed the slot — full refund " # Nat.toText(b.depositCents) # "c");
          };
        };
        ignore Map.take(waitlists, Nat.compare, slotId);
        Map.add(slots, Nat.compare, slotId, { slot with closed = true; seatsBooked = 0 });
        logEvent(caller, "slot.close", slotId, refunded, Nat.toText(refunded) # " booking(s) refunded");
        #ok(refunded);
      };
    };
  };
  public shared (msg) func closeSlot(slotId : Nat) : async Result.Result<Nat, Text> {
    Result.mapErr(doCloseSlot(msg.caller, slotId), errText);
  };
  public shared (msg) func closeSlotOrTrap(slotId : Nat) : async Nat {
    switch (doCloseSlot(msg.caller, slotId)) { case (#ok n) n; case (#err e) Runtime.trap(errText(e)) };
  };

  // ── Booking (any signed-in customer) ──

  func doBook(caller : Principal, slotId : Nat, seats : Nat) : R<Nat> {
    Admin.requireNotPaused(admin);
    if (Principal.isAnonymous(caller)) return #err(#notAuthorized);
    if (seats == 0) return #err(#invalid("Book at least one seat"));
    switch (getSlot(slotId)) {
      case null #err(#notFound("Slot"));
      case (?slot) {
        if (slot.closed) return #err(#stateError("This slot was cancelled by the house"));
        if (slot.startNs <= Time.now()) return #err(#windowClosed("This time has already started"));
        switch (getListing(slot.listingId)) {
          case null #err(#notFound("Listing"));
          case (?listing) {
            if (listing.archived) return #err(#invalid("Listing is no longer offered"));
            let free = remainingSeats(slot);
            if (seats > free) return #err(#slotFull({ remaining = free }));
            // Check and writes share this synchronous step — two concurrent
            // callers can never both see the same seats as free.
            let b = writeBooking(caller, listing, slot, seats, false);
            #ok(b.id);
          };
        };
      };
    };
  };
  public shared (msg) func book(slotId : Nat, seats : Nat) : async Result.Result<Nat, Text> {
    Result.mapErr(doBook(msg.caller, slotId, seats), errText);
  };
  public shared (msg) func bookOrTrap(slotId : Nat, seats : Nat) : async Nat {
    switch (doBook(msg.caller, slotId, seats)) { case (#ok id) id; case (#err e) Runtime.trap(errText(e)) };
  };

  // Customer cancellation. Before the listing's cancellation window closes the
  // deposit comes back in full; inside the window it is forfeited to the house.
  // Either way the seats free up and the waitlist is promoted immediately.
  func doCancelBooking(caller : Principal, bookingId : Nat) : R<Text> {
    Admin.requireNotPaused(admin);
    switch (Map.get(bookings, Nat.compare, bookingId)) {
      case null #err(#notFound("Booking"));
      case (?b) {
        if (b.customer != caller) return #err(#notAuthorized);
        if (b.status != #confirmed) return #err(#stateError("Only a confirmed booking can be cancelled — this one is " # statusText(b.status)));
        switch (getSlot(b.slotId), getListing(b.listingId)) {
          case (?slot, ?listing) {
            let now = Time.now();
            if (slot.startNs <= now) return #err(#windowClosed("This time has already started — it can no longer be cancelled"));
            let freeCancel = now <= cancelDeadline(listing, slot);
            let outcome = if (freeCancel) {
              refundedCents += b.depositCents;
              "refunded";
            } else {
              forfeitedCents += b.depositCents;
              "forfeited";
            };
            Map.add(bookings, Nat.compare, bookingId, { b with status = #cancelled; decidedAt = ?now });
            let newBooked = if (slot.seatsBooked >= b.seats) slot.seatsBooked - b.seats else 0;
            Map.add(slots, Nat.compare, slot.id, { slot with seatsBooked = newBooked });
            logEvent(caller, "booking.cancel." # outcome, bookingId, slot.id, "deposit " # Nat.toText(b.depositCents) # "c " # outcome);
            promoteWaitlist(slot.id);
            #ok(outcome);
          };
          case _ #err(#stateError("Booking references a missing slot or listing"));
        };
      };
    };
  };
  public shared (msg) func cancelBooking(bookingId : Nat) : async Result.Result<Text, Text> {
    Result.mapErr(doCancelBooking(msg.caller, bookingId), errText);
  };
  // Returns the outcome as a 1-element record vec (the SDK decodes vec-record,
  // not bare text): outcome = "refunded" | "forfeited".
  public shared (msg) func cancelBookingOrTrap(bookingId : Nat) : async [{ outcome : Text }] {
    switch (doCancelBooking(msg.caller, bookingId)) { case (#ok t) [{ outcome = t }]; case (#err e) Runtime.trap(errText(e)) };
  };

  // ── Waitlist ──

  func doJoinWaitlist(caller : Principal, slotId : Nat, seats : Nat) : R<Nat> {
    Admin.requireNotPaused(admin);
    if (Principal.isAnonymous(caller)) return #err(#notAuthorized);
    if (seats == 0) return #err(#invalid("Wait for at least one seat"));
    switch (getSlot(slotId)) {
      case null #err(#notFound("Slot"));
      case (?slot) {
        if (slot.closed) return #err(#stateError("This slot was cancelled by the house"));
        if (slot.startNs <= Time.now()) return #err(#windowClosed("This time has already started"));
        if (seats <= remainingSeats(slot)) return #err(#invalid("Seats are free right now — book them instead of waiting"));
        let queue = switch (Map.get(waitlists, Nat.compare, slotId)) { case (?q) q; case null [] };
        if (queue.size() >= maxWaitlist) return #err(#invalid("The waitlist is full"));
        for (e in queue.values()) {
          if (e.customer == caller) return #err(#invalid("You are already on this waitlist"));
        };
        Map.add(waitlists, Nat.compare, slotId, Array.concat(queue, [{ customer = caller; seats; joinedAt = Time.now() }]));
        logEvent(caller, "waitlist.join", slotId, seats, "position " # Nat.toText(queue.size() + 1));
        #ok(queue.size() + 1);
      };
    };
  };
  public shared (msg) func joinWaitlist(slotId : Nat, seats : Nat) : async Result.Result<Nat, Text> {
    Result.mapErr(doJoinWaitlist(msg.caller, slotId, seats), errText);
  };
  public shared (msg) func joinWaitlistOrTrap(slotId : Nat, seats : Nat) : async Nat {
    switch (doJoinWaitlist(msg.caller, slotId, seats)) { case (#ok p) p; case (#err e) Runtime.trap(errText(e)) };
  };

  func doLeaveWaitlist(caller : Principal, slotId : Nat) : R<()> {
    switch (Map.get(waitlists, Nat.compare, slotId)) {
      case null #err(#notFound("Waitlist entry"));
      case (?queue) {
        let filtered = Array.filter(queue, func(e : WaitEntry) : Bool { e.customer != caller });
        if (filtered.size() == queue.size()) return #err(#notFound("Waitlist entry"));
        if (filtered.size() == 0) { ignore Map.take(waitlists, Nat.compare, slotId) }
        else { Map.add(waitlists, Nat.compare, slotId, filtered) };
        logEvent(caller, "waitlist.leave", slotId, 0, "");
        // Leaving can unblock the queue behind a too-big head.
        promoteWaitlist(slotId);
        #ok(());
      };
    };
  };
  public shared (msg) func leaveWaitlist(slotId : Nat) : async Result.Result<(), Text> {
    Result.mapErr(doLeaveWaitlist(msg.caller, slotId), errText);
  };
  public shared (msg) func leaveWaitlistOrTrap(slotId : Nat) : async () {
    switch (doLeaveWaitlist(msg.caller, slotId)) { case (#ok _) {}; case (#err e) Runtime.trap(errText(e)) };
  };

  // ── Front desk (owner-gated lifecycle) ──

  func doCheckIn(caller : Principal, bookingId : Nat) : R<()> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) return #err(#notAuthorized);
    switch (Map.get(bookings, Nat.compare, bookingId)) {
      case null #err(#notFound("Booking"));
      case (?b) {
        if (b.status != #confirmed) return #err(#stateError("Only a confirmed booking can check in — this one is " # statusText(b.status)));
        switch (getSlot(b.slotId)) {
          case null #err(#stateError("Booking references a missing slot"));
          case (?slot) {
            let now = Time.now();
            if (now < slot.startNs - 60 * nsPerMinute) return #err(#windowClosed("Check-in opens an hour before start"));
            if (now >= slot.endNs) return #err(#windowClosed("This time is already over — mark it a no-show or completed"));
            Map.add(bookings, Nat.compare, bookingId, { b with status = #checkedIn });
            logEvent(caller, "booking.checkin", bookingId, slot.id, "");
            #ok(());
          };
        };
      };
    };
  };
  public shared (msg) func checkIn(bookingId : Nat) : async Result.Result<(), Text> {
    Result.mapErr(doCheckIn(msg.caller, bookingId), errText);
  };
  public shared (msg) func checkInOrTrap(bookingId : Nat) : async () {
    switch (doCheckIn(msg.caller, bookingId)) { case (#ok _) {}; case (#err e) Runtime.trap(errText(e)) };
  };

  func doMarkNoShow(caller : Principal, bookingId : Nat) : R<()> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) return #err(#notAuthorized);
    switch (Map.get(bookings, Nat.compare, bookingId)) {
      case null #err(#notFound("Booking"));
      case (?b) {
        if (b.status != #confirmed) return #err(#stateError("Only a confirmed booking can be a no-show — this one is " # statusText(b.status)));
        switch (getSlot(b.slotId)) {
          case null #err(#stateError("Booking references a missing slot"));
          case (?slot) {
            let now = Time.now();
            if (now < slot.startNs) return #err(#windowClosed("The slot hasn't started yet — a guest can't be a no-show early"));
            Map.add(bookings, Nat.compare, bookingId, { b with status = #noShow; decidedAt = ?now });
            let newBooked = if (slot.seatsBooked >= b.seats) slot.seatsBooked - b.seats else 0;
            Map.add(slots, Nat.compare, slot.id, { slot with seatsBooked = newBooked });
            forfeitedCents += b.depositCents;
            logEvent(caller, "booking.noshow", bookingId, slot.id, "deposit " # Nat.toText(b.depositCents) # "c forfeited");
            #ok(());
          };
        };
      };
    };
  };
  public shared (msg) func markNoShow(bookingId : Nat) : async Result.Result<(), Text> {
    Result.mapErr(doMarkNoShow(msg.caller, bookingId), errText);
  };
  public shared (msg) func markNoShowOrTrap(bookingId : Nat) : async () {
    switch (doMarkNoShow(msg.caller, bookingId)) { case (#ok _) {}; case (#err e) Runtime.trap(errText(e)) };
  };

  func doComplete(caller : Principal, bookingId : Nat) : R<()> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) return #err(#notAuthorized);
    switch (Map.get(bookings, Nat.compare, bookingId)) {
      case null #err(#notFound("Booking"));
      case (?b) {
        if (b.status != #checkedIn) return #err(#stateError("Only a checked-in booking can complete — this one is " # statusText(b.status)));
        switch (getSlot(b.slotId)) {
          case null #err(#stateError("Booking references a missing slot"));
          case (?slot) {
            let now = Time.now();
            Map.add(bookings, Nat.compare, bookingId, { b with status = #completed; decidedAt = ?now });
            let newBooked = if (slot.seatsBooked >= b.seats) slot.seatsBooked - b.seats else 0;
            Map.add(slots, Nat.compare, slot.id, { slot with seatsBooked = newBooked });
            capturedCents += b.depositCents;
            logEvent(caller, "booking.complete", bookingId, slot.id, "deposit " # Nat.toText(b.depositCents) # "c captured");
            #ok(());
          };
        };
      };
    };
  };
  public shared (msg) func complete(bookingId : Nat) : async Result.Result<(), Text> {
    Result.mapErr(doComplete(msg.caller, bookingId), errText);
  };
  public shared (msg) func completeOrTrap(bookingId : Nat) : async () {
    switch (doComplete(msg.caller, bookingId)) { case (#ok _) {}; case (#err e) Runtime.trap(errText(e)) };
  };

  // ── Demo seed ──

  // Populate a fresh deploy so the harbor looks alive on first load: six
  // listings across kinds, a week of published slots, and a handful of real
  // bookings held by the seeding caller (real bookings, real deposits — the
  // invariant oracle must be green from the very first read). Idempotent:
  // a no-op once any listing exists. Bypasses the owner gate intentionally —
  // it only fires on an empty, just-deployed contract.
  public shared (msg) func seedDemo() : async Bool {
    Admin.requireNotPaused(admin);
    if (Principal.isAnonymous(msg.caller)) Runtime.trap("anonymous caller");
    if (Map.size(listings) > 0) return false;
    let now = Time.now();
    let hour : Int = 60 * nsPerMinute;
    let day : Int = 24 * hour;

    func listing(name : Text, description : Text, kind : Text, dur : Nat, price : Nat, cap : Nat, window : Nat) : Nat {
      let id = nextListingId;
      nextListingId += 1;
      Map.add(listings, Nat.compare, id, {
        id; name; description; kind; durationMinutes = dur; priceCents = price;
        capacity = cap; cancelWindowMinutes = window; photoPath = null; archived = false;
      });
      id;
    };

    let sail = listing("Harbor Day Sail", "A skippered afternoon on a 38-foot sloop — bring seven friends.", "sail", 180, 24_000, 8, 24 * 60);
    let ev = listing("City EV, full day", "Door-to-door electric hatchback, charged and waiting at the quay.", "ev", 600, 8_900, 1, 12 * 60);
    let studio = listing("Recording Studio A", "Treated live room, Neumann pair, engineer included.", "studio", 60, 5_000, 1, 6 * 60);
    let court = listing("Padel Court 1", "Covered court, rackets and balls at the desk.", "court", 90, 3_200, 4, 2 * 60);
    let sauna = listing("Sauna & Cold Plunge", "Cedar sauna, six benches, ten-degree plunge barrel.", "sauna", 120, 4_500, 6, 4 * 60);
    let loft = listing("Photography Loft", "North light, backdrops, a wall of windows over the water.", "loft", 240, 15_000, 2, 24 * 60);

    ignore doPublishSlots(msg.caller, sail, now + 20 * hour, now + 7 * day, 24 * 60, 0);
    ignore doPublishSlots(msg.caller, ev, now + 14 * hour, now + 7 * day, 24 * 60, 0);
    ignore doPublishSlots(msg.caller, studio, now + 2 * hour, now + 2 * day, 2 * 60, 0);
    ignore doPublishSlots(msg.caller, court, now + 3 * hour, now + 3 * day, 3 * 60, 0);
    ignore doPublishSlots(msg.caller, sauna, now + 5 * hour, now + 4 * day, 6 * 60, 0);
    ignore doPublishSlots(msg.caller, loft, now + 30 * hour, now + 7 * day, 24 * 60, 0);

    // A lived-in board: the seeder holds real seats (real deposits in escrow).
    var taken : Nat = 0;
    for ((_, s) in Map.entries(slots)) {
      if (s.listingId == court and taken == 0) {
        // One court slot filled to capacity — the waitlist story is live.
        ignore doBook(msg.caller, s.id, 4);
        taken += 1;
      };
    };
    var sailTaken = false;
    var saunaTaken : Nat = 0;
    for ((_, s) in Map.entries(slots)) {
      if (s.listingId == sail and not sailTaken) { ignore doBook(msg.caller, s.id, 5); sailTaken := true };
      if (s.listingId == sauna and saunaTaken < 2) { ignore doBook(msg.caller, s.id, 2); saunaTaken += 1 };
    };
    logEvent(msg.caller, "demo.seed", Map.size(listings), Map.size(slots), "demo harbor seeded");
    true;
  };

  // ── The invariant oracle (public — anyone can audit the guard) ──

  type Violation = { rule : Text; detail : Text };

  func computeViolations() : [Violation] {
    let out = List.empty<Violation>();

    // R1 capacity: recompute active seats per slot from the booking book.
    let activePerSlot = Map.empty<Nat, Nat>();
    for ((_, b) in Map.entries(bookings)) {
      if (isActive(b.status)) {
        let prev = switch (Map.get(activePerSlot, Nat.compare, b.slotId)) { case (?n) n; case null 0 };
        Map.add(activePerSlot, Nat.compare, b.slotId, prev + b.seats);
      };
    };
    for ((_, s) in Map.entries(slots)) {
      let active = switch (Map.get(activePerSlot, Nat.compare, s.id)) { case (?n) n; case null 0 };
      if (active > s.capacity) {
        List.add(out, { rule = "R1 capacity"; detail = "slot #" # Nat.toText(s.id) # " holds " # Nat.toText(active) # " active seats over capacity " # Nat.toText(s.capacity) });
      };
      if (active != s.seatsBooked) {
        List.add(out, { rule = "R1 counter"; detail = "slot #" # Nat.toText(s.id) # " counter says " # Nat.toText(s.seatsBooked) # " but the booking book sums to " # Nat.toText(active) });
      };
    };

    // R2 waitlist: on a future open slot, the head must not fit (else it
    // should have been promoted).
    let now = Time.now();
    for ((slotId, queue) in Map.entries(waitlists)) {
      switch (getSlot(slotId)) {
        case null List.add(out, { rule = "R2 waitlist"; detail = "waitlist exists for missing slot #" # Nat.toText(slotId) });
        case (?s) {
          if (queue.size() > 0 and not s.closed and s.startNs > now) {
            if (queue[0].seats <= remainingSeats(s)) {
              List.add(out, { rule = "R2 waitlist"; detail = "slot #" # Nat.toText(slotId) # " has " # Nat.toText(remainingSeats(s)) # " free seats while a party of " # Nat.toText(queue[0].seats) # " waits" });
            };
          };
        };
      };
    };

    // R3 escrow conservation: collected == held(recomputed) + refunded +
    // forfeited + captured.
    var held : Nat = 0;
    for ((_, b) in Map.entries(bookings)) {
      if (isActive(b.status)) held += b.depositCents;
    };
    if (collectedCents != held + refundedCents + forfeitedCents + capturedCents) {
      List.add(out, {
        rule = "R3 escrow";
        detail = "collected " # Nat.toText(collectedCents) # "c != held " # Nat.toText(held) # "c + refunded " # Nat.toText(refundedCents) # "c + forfeited " # Nat.toText(forfeitedCents) # "c + captured " # Nat.toText(capturedCents) # "c";
      });
    };

    // R4 schedule: no two open slots of a listing overlap.
    let all = Iter.toArray(Map.values(slots));
    var i = 0;
    while (i < all.size()) {
      var j = i + 1;
      while (j < all.size()) {
        let a = all[i]; let b = all[j];
        if (a.listingId == b.listingId and not a.closed and not b.closed and a.startNs < b.endNs and b.startNs < a.endNs) {
          List.add(out, { rule = "R4 schedule"; detail = "slots #" # Nat.toText(a.id) # " and #" # Nat.toText(b.id) # " of listing #" # Nat.toText(a.listingId) # " overlap in time" });
        };
        j += 1;
      };
      i += 1;
    };

    // R5 index: every indexed id resolves to a booking owned by that customer,
    // and every booking is indexed under its customer.
    for ((cust, ids) in Map.entries(customerBookings)) {
      for (id in List.values(ids)) {
        switch (Map.get(bookings, Nat.compare, id)) {
          case null List.add(out, { rule = "R5 index"; detail = "index points at missing booking #" # Nat.toText(id) });
          case (?b) {
            if (b.customer != cust) List.add(out, { rule = "R5 index"; detail = "booking #" # Nat.toText(id) # " indexed under the wrong customer" });
          };
        };
      };
    };
    for ((_, b) in Map.entries(bookings)) {
      let found = switch (Map.get(customerBookings, Principal.compare, b.customer)) {
        case null false;
        case (?ids) {
          var hit = false;
          for (id in List.values(ids)) { if (id == b.id) hit := true };
          hit;
        };
      };
      if (not found) List.add(out, { rule = "R5 index"; detail = "booking #" # Nat.toText(b.id) # " is missing from its customer's index" });
    };

    List.toArray(out);
  };

  public query func invariantReportView() : async [{ rule : Text; detail : Text }] {
    computeViolations();
  };

  // One-row summary for the footer seal: the escrow ledger + violation count.
  public query func conservationView() : async [{ ok : Nat; collectedCents : Nat; heldCents : Nat; refundedCents : Nat; forfeitedCents : Nat; capturedCents : Nat; violations : Nat }] {
    var held : Nat = 0;
    for ((_, b) in Map.entries(bookings)) { if (isActive(b.status)) held += b.depositCents };
    let v = computeViolations().size();
    [{ ok = if (v == 0) 1 else 0; collectedCents; heldCents = held; refundedCents; forfeitedCents; capturedCents; violations = v }];
  };

  // ── Frontend view-models (flat records — easy to decode in the SPA) ──

  // Chain clock for the SPA: Time.now() counts from GENESIS, not the epoch;
  // clients calibrate wall time as Date.now() + (nowNs here − their receipt time).
  public query func timeView() : async [{ nowNs : Int }] { [{ nowNs = Time.now() }] };

  public query func listingsView() : async [{
    id : Nat; name : Text; description : Text; kind : Text; durationMinutes : Nat;
    priceCents : Nat; capacity : Nat; cancelWindowMinutes : Nat; photoPath : Text;
    archived : Nat; slotsFree : Nat; slotsTotal : Nat; nextFreeNs : Int; utilizationBps : Nat;
  }] {
    let now = Time.now();
    Array.map<Listing, { id : Nat; name : Text; description : Text; kind : Text; durationMinutes : Nat; priceCents : Nat; capacity : Nat; cancelWindowMinutes : Nat; photoPath : Text; archived : Nat; slotsFree : Nat; slotsTotal : Nat; nextFreeNs : Int; utilizationBps : Nat }>(
      Iter.toArray(Map.values(listings)),
      func(l) {
        var free : Nat = 0; var total : Nat = 0;
        var seatsCap : Nat = 0; var seatsBooked : Nat = 0;
        var nextFree : Int = 0;
        for ((_, s) in Map.entries(slots)) {
          if (s.listingId == l.id and not s.closed and s.startNs > now) {
            total += 1;
            seatsCap += s.capacity;
            seatsBooked += s.seatsBooked;
            if (remainingSeats(s) > 0) {
              free += 1;
              if (nextFree == 0 or s.startNs < nextFree) nextFree := s.startNs;
            };
          };
        };
        {
          id = l.id; name = l.name; description = l.description; kind = l.kind;
          durationMinutes = l.durationMinutes; priceCents = l.priceCents;
          capacity = l.capacity; cancelWindowMinutes = l.cancelWindowMinutes;
          photoPath = (switch (l.photoPath) { case (?p) p; case null "" });
          archived = if (l.archived) 1 else 0;
          slotsFree = free; slotsTotal = total; nextFreeNs = nextFree;
          utilizationBps = if (seatsCap == 0) 0 else seatsBooked * 10_000 / seatsCap;
        };
      },
    );
  };

  public shared query (msg) func slotsView(listingId : Nat) : async [{
    id : Nat; listingId : Nat; startNs : Int; endNs : Int; capacity : Nat;
    seatsBooked : Nat; remaining : Nat; waitlistLen : Nat; mySeats : Nat; myWaitPos : Nat;
  }] {
    let now = Time.now();
    // The caller's active seats per slot (so the UI can say "you're in").
    let mineActive = Map.empty<Nat, Nat>();
    for ((_, b) in Map.entries(bookings)) {
      if (b.customer == msg.caller and isActive(b.status)) {
        let prev = switch (Map.get(mineActive, Nat.compare, b.slotId)) { case (?n) n; case null 0 };
        Map.add(mineActive, Nat.compare, b.slotId, prev + b.seats);
      };
    };
    let future = Array.filter(Iter.toArray(Map.values(slots)), func(s : Slot) : Bool {
      s.listingId == listingId and not s.closed and s.startNs > now;
    });
    let sorted = Array.sort(future, func(a : Slot, b : Slot) : { #less; #equal; #greater } { Int.compare(a.startNs, b.startNs) });
    Array.map<Slot, { id : Nat; listingId : Nat; startNs : Int; endNs : Int; capacity : Nat; seatsBooked : Nat; remaining : Nat; waitlistLen : Nat; mySeats : Nat; myWaitPos : Nat }>(sorted, func(s) {
      let queue = switch (Map.get(waitlists, Nat.compare, s.id)) { case (?q) q; case null [] };
      var myPos : Nat = 0;
      var i : Nat = 0;
      for (e in queue.values()) {
        i += 1;
        if (e.customer == msg.caller and myPos == 0) myPos := i;
      };
      {
        id = s.id; listingId = s.listingId; startNs = s.startNs; endNs = s.endNs;
        capacity = s.capacity; seatsBooked = s.seatsBooked; remaining = remainingSeats(s);
        waitlistLen = queue.size();
        mySeats = switch (Map.get(mineActive, Nat.compare, s.id)) { case (?n) n; case null 0 };
        myWaitPos = myPos;
      };
    });
  };

  // Every open future slot across the harbor for the next 7 days — the hero
  // tide clock draws straight from this.
  public query func boardView() : async [{
    id : Nat; listingId : Nat; kind : Text; startNs : Int; endNs : Int; capacity : Nat; remaining : Nat;
  }] {
    let now = Time.now();
    let horizon = now + 7 * 24 * 60 * nsPerMinute;
    let upcoming = Array.filter(Iter.toArray(Map.values(slots)), func(s : Slot) : Bool {
      not s.closed and s.startNs > now and s.startNs < horizon;
    });
    let sorted = Array.sort(upcoming, func(a : Slot, b : Slot) : { #less; #equal; #greater } { Int.compare(a.startNs, b.startNs) });
    Array.map<Slot, { id : Nat; listingId : Nat; kind : Text; startNs : Int; endNs : Int; capacity : Nat; remaining : Nat }>(sorted, func(s) {
      let kind = switch (getListing(s.listingId)) { case (?l) l.kind; case null "" };
      { id = s.id; listingId = s.listingId; kind; startNs = s.startNs; endNs = s.endNs; capacity = s.capacity; remaining = remainingSeats(s) };
    });
  };

  public shared query (msg) func myBookingsView() : async [{
    id : Nat; listingId : Nat; listingName : Text; kind : Text; startNs : Int; endNs : Int;
    seats : Nat; depositCents : Nat; status : Text; cancelDeadlineNs : Int; promoted : Nat; nowNs : Int;
  }] {
    let now = Time.now();
    let ids = switch (Map.get(customerBookings, Principal.compare, msg.caller)) { case (?l) List.toArray(l); case null [] };
    let rows = Array.map<Nat, { id : Nat; listingId : Nat; listingName : Text; kind : Text; startNs : Int; endNs : Int; seats : Nat; depositCents : Nat; status : Text; cancelDeadlineNs : Int; promoted : Nat; nowNs : Int }>(ids, func(id) {
      switch (Map.get(bookings, Nat.compare, id)) {
        case (?b) {
          let (lname, kind, deadline) = switch (getListing(b.listingId), getSlot(b.slotId)) {
            case (?l, ?s) (l.name, l.kind, cancelDeadline(l, s));
            case (?l, null) (l.name, l.kind, 0 : Int);
            case _ ("(removed)", "", 0 : Int);
          };
          let (startNs, endNs) = switch (getSlot(b.slotId)) { case (?s) (s.startNs, s.endNs); case null (0 : Int, 0 : Int) };
          {
            id = b.id; listingId = b.listingId; listingName = lname; kind;
            startNs; endNs; seats = b.seats; depositCents = b.depositCents;
            status = statusText(b.status); cancelDeadlineNs = deadline;
            promoted = if (b.promoted) 1 else 0; nowNs = now;
          };
        };
        case null {
          { id; listingId = 0; listingName = "(missing)"; kind = ""; startNs = 0 : Int; endNs = 0 : Int; seats = 0; depositCents = 0; status = ""; cancelDeadlineNs = 0 : Int; promoted = 0; nowNs = now };
        };
      };
    });
    Array.sort(rows, func(a : { id : Nat; listingId : Nat; listingName : Text; kind : Text; startNs : Int; endNs : Int; seats : Nat; depositCents : Nat; status : Text; cancelDeadlineNs : Int; promoted : Nat; nowNs : Int }, b : { id : Nat; listingId : Nat; listingName : Text; kind : Text; startNs : Int; endNs : Int; seats : Nat; depositCents : Nat; status : Text; cancelDeadlineNs : Int; promoted : Nat; nowNs : Int }) : { #less; #equal; #greater } {
      Int.compare(b.startNs, a.startNs);
    });
  };

  public shared query (msg) func myWaitlistView() : async [{
    slotId : Nat; listingId : Nat; listingName : Text; startNs : Int; seats : Nat; position : Nat; nowNs : Int;
  }] {
    let now = Time.now();
    let out = List.empty<{ slotId : Nat; listingId : Nat; listingName : Text; startNs : Int; seats : Nat; position : Nat; nowNs : Int }>();
    for ((slotId, queue) in Map.entries(waitlists)) {
      var pos : Nat = 0;
      var i : Nat = 0;
      var seats : Nat = 0;
      for (e in queue.values()) {
        i += 1;
        if (e.customer == msg.caller and pos == 0) { pos := i; seats := e.seats };
      };
      if (pos > 0) {
        switch (getSlot(slotId)) {
          case (?s) {
            let lname = switch (getListing(s.listingId)) { case (?l) l.name; case null "(removed)" };
            List.add(out, { slotId; listingId = s.listingId; listingName = lname; startNs = s.startNs; seats; position = pos; nowNs = now });
          };
          case null {};
        };
      };
    };
    List.toArray(out);
  };

  // Owner-gated day agenda: everything on the books in [fromNs, toNs).
  public shared query (msg) func agendaView(fromNs : Int, toNs : Int) : async [{
    bookingId : Nat; listingId : Nat; listingName : Text; customer : Principal;
    seats : Nat; depositCents : Nat; startNs : Int; endNs : Int; status : Text; promoted : Nat;
  }] {
    if (not isOwnerOrAdmin(msg.caller)) return [];
    let out = List.empty<{ bookingId : Nat; listingId : Nat; listingName : Text; customer : Principal; seats : Nat; depositCents : Nat; startNs : Int; endNs : Int; status : Text; promoted : Nat }>();
    for ((_, b) in Map.entries(bookings)) {
      switch (getSlot(b.slotId)) {
        case (?s) {
          if (s.startNs >= fromNs and s.startNs < toNs) {
            let lname = switch (getListing(b.listingId)) { case (?l) l.name; case null "(removed)" };
            List.add(out, { bookingId = b.id; listingId = b.listingId; listingName = lname; customer = b.customer; seats = b.seats; depositCents = b.depositCents; startNs = s.startNs; endNs = s.endNs; status = statusText(b.status); promoted = if (b.promoted) 1 else 0 });
          };
        };
        case null {};
      };
    };
    let arr = List.toArray(out);
    Array.sort(arr, func(a : { bookingId : Nat; listingId : Nat; listingName : Text; customer : Principal; seats : Nat; depositCents : Nat; startNs : Int; endNs : Int; status : Text; promoted : Nat }, b : { bookingId : Nat; listingId : Nat; listingName : Text; customer : Principal; seats : Nat; depositCents : Nat; startNs : Int; endNs : Int; status : Text; promoted : Nat }) : { #less; #equal; #greater } {
      Int.compare(a.startNs, b.startNs);
    });
  };

  public query func statsView() : async [{
    listings : Nat; slotsOpen : Nat; slotsClosed : Nat; bookingsTotal : Nat;
    confirmed : Nat; checkedIn : Nat; completed : Nat; cancelled : Nat; noShows : Nat;
    waitlistEntries : Nat; auditEvents : Nat; futureSeatsBooked : Nat; futureSeatsCapacity : Nat;
  }] {
    let now = Time.now();
    var open : Nat = 0; var closed : Nat = 0;
    var fSeats : Nat = 0; var fCap : Nat = 0;
    for ((_, s) in Map.entries(slots)) {
      if (s.closed) closed += 1 else open += 1;
      if (not s.closed and s.startNs > now) { fSeats += s.seatsBooked; fCap += s.capacity };
    };
    var confirmed : Nat = 0; var checkedIn : Nat = 0; var completed : Nat = 0;
    var cancelled : Nat = 0; var noShows : Nat = 0;
    for ((_, b) in Map.entries(bookings)) {
      switch (b.status) {
        case (#confirmed) confirmed += 1; case (#checkedIn) checkedIn += 1;
        case (#completed) completed += 1; case (#cancelled) cancelled += 1;
        case (#noShow) noShows += 1;
      };
    };
    var wl : Nat = 0;
    for ((_, q) in Map.entries(waitlists)) { wl += q.size() };
    [{
      listings = Map.size(listings); slotsOpen = open; slotsClosed = closed;
      bookingsTotal = Map.size(bookings); confirmed; checkedIn; completed; cancelled;
      noShows; waitlistEntries = wl; auditEvents = List.size(audit);
      futureSeatsBooked = fSeats; futureSeatsCapacity = fCap;
    }];
  };

  // Owner-gated audit feed, newest first, capped by `limit`.
  public shared query (msg) func auditView(limit : Nat) : async [{
    seq : Nat; at : Int; who : Principal; kind : Text; refA : Nat; refB : Nat; note : Text;
  }] {
    if (not isOwnerOrAdmin(msg.caller)) return [];
    let all = List.toArray(audit);
    let n = all.size();
    let take = if (limit == 0 or limit > n) n else limit;
    let out = List.empty<{ seq : Nat; at : Int; who : Principal; kind : Text; refA : Nat; refB : Nat; note : Text }>();
    var i = n;
    while (i > n - take) {
      i -= 1;
      let e = all[i];
      List.add(out, { seq = e.seq; at = e.at; who = e.who; kind = e.kind; refA = e.refA; refB = e.refB; note = e.note });
    };
    List.toArray(out);
  };
}
